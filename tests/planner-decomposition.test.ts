import { describe, expect, it } from "bun:test";
import {
  isActionableGoal,
  maxGoalsForTask,
  planTask,
} from "../src/agent/planner.ts";
import type { PlannerOptions } from "../src/agent/planner.ts";
import type { ContextBundle, ContextChunk } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  StreamChunk,
} from "../src/provider/types.ts";

// We re-import to reach the constant for prompt content checks
// (it is not exported, so we test via the provider mock + system message)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(): ModelProfile {
  return {
    id: "test-model",
    label: "Test Model",
    contextWindow: 4096,
    samplingDefaults: { temperature: 0.2, top_p: 0.9, top_k: -1, max_tokens: 1024 },
    supportsGrammar: false,
    supportsJsonSchema: false,
  };
}

function makeContext(chunks: Partial<ContextChunk>[] = []): ContextBundle {
  const full: ContextChunk[] = chunks.map((c, i) => ({
    filePath: c.filePath ?? `src/file${i}.ts`,
    startLine: c.startLine ?? 1,
    endLine: c.endLine ?? 10,
    content: c.content ?? "",
    estimatedTokens: c.estimatedTokens ?? 50,
  }));
  return {
    chunks: full,
    totalTokens: 0,
    tokenBudget: 2048,
    truncated: false,
    query: "test",
  };
}

function makeRecordingProvider(responses: string[]): { provider: Provider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const provider: Provider = {
    complete: async (req: CompletionRequest): Promise<CompletionResponse> => {
      calls.push(req);
      const idx = Math.min(calls.length - 1, responses.length - 1);
      return {
        rawContent: responses[idx] ?? "",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      };
    },
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "", done: true };
    },
  };
  return { provider, calls };
}

function makeOpts(provider: Provider, overrides: Partial<PlannerOptions> = {}): PlannerOptions {
  return {
    provider,
    modelId: "test-model",
    profile: makeProfile(),
    repoRoot: "/tmp/test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isActionableGoal — accept / reject examples
// ---------------------------------------------------------------------------

describe("isActionableGoal — reject cases", () => {
  it("rejects bare file path with line range", () => {
    expect(isActionableGoal("src/config/index.ts (lines 1–11)")).toBe(false);
  });

  it("rejects bare file path with ASCII dash line range", () => {
    expect(isActionableGoal("src/config/index.ts (lines 1-11)")).toBe(false);
  });

  it("rejects bare file path no extension", () => {
    expect(isActionableGoal("src/foo.ts")).toBe(false);
  });

  it("rejects path with no extension", () => {
    expect(isActionableGoal("utils/helpers")).toBe(false);
  });

  it("rejects path with trailing slash", () => {
    expect(isActionableGoal("src/config/")).toBe(false);
  });

  it("rejects single word noun", () => {
    expect(isActionableGoal("TODO")).toBe(false);
  });

  it("rejects single word filename", () => {
    expect(isActionableGoal("planner.ts")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isActionableGoal("")).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    expect(isActionableGoal("   ")).toBe(false);
  });

  it("rejects relative path starting with ./", () => {
    expect(isActionableGoal("./src/utils.ts")).toBe(false);
  });

  it("rejects path with line range using em-dash", () => {
    expect(isActionableGoal("src/agent/planner.ts (lines 28–64)")).toBe(false);
  });
});

describe("isActionableGoal — accept cases", () => {
  it("accepts: Add null check in parseConfig", () => {
    expect(isActionableGoal("Add null check in parseConfig")).toBe(true);
  });

  it("accepts: Implement getActiveProfile in src/config/resolve.ts", () => {
    expect(isActionableGoal("Implement getActiveProfile in src/config/resolve.ts")).toBe(true);
  });

  it("accepts: Write tests for the new branch", () => {
    expect(isActionableGoal("Write tests for the new branch")).toBe(true);
  });

  it("accepts: Fix the off-by-one in loop.ts", () => {
    expect(isActionableGoal("Fix the off-by-one in loop.ts")).toBe(true);
  });

  it("accepts: Read src/config.ts to understand the current structure", () => {
    expect(isActionableGoal("Read src/config.ts to understand the current structure")).toBe(true);
  });

  it("accepts: Run tests to verify the fix", () => {
    expect(isActionableGoal("Run tests to verify the fix")).toBe(true);
  });

  it("accepts: Refactor parseGoals to remove the slice(0, 8) hard cap", () => {
    expect(isActionableGoal("Refactor parseGoals to remove the slice(0, 8) hard cap")).toBe(true);
  });

  it("accepts: Update PLANNER_SYSTEM_PROMPT with tighter constraints", () => {
    expect(isActionableGoal("Update PLANNER_SYSTEM_PROMPT with tighter constraints")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// maxGoalsForTask
// ---------------------------------------------------------------------------

describe("maxGoalsForTask", () => {
  it("returns 3 for single-file context", () => {
    expect(maxGoalsForTask("fix the null check", 1)).toBe(3);
  });

  it("returns 3 for zero-file context (no context)", () => {
    expect(maxGoalsForTask("create resolve.ts", 0)).toBe(3);
  });

  it("returns 3 for short task with 2 unique files but ≤10 words and ≤1 path word", () => {
    // task: "fix the bug in bar" — 5 words, no path-like tokens
    expect(maxGoalsForTask("fix the bug in bar", 2)).toBe(3);
  });

  it("returns 5 for multi-file context with a complex task", () => {
    const bigTask =
      "Implement the new authentication flow across auth.ts, config.ts, and middleware/jwt.ts";
    expect(maxGoalsForTask(bigTask, 5)).toBe(5);
  });

  it("returns 5 for 3 unique files regardless of task length when task is long", () => {
    const longTask = "Refactor the entire auth module replacing passport with a custom JWT library implementation";
    expect(maxGoalsForTask(longTask, 3)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Context summary sanitization
// ---------------------------------------------------------------------------

describe("planTask — context summary sanitization", () => {
  it("deduplicates chunks from the same file — only one path entry, no line ranges", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Add null check\n2. Run tests"]);

    const context = makeContext([
      { filePath: "src/config.ts", startLine: 1, endLine: 20 },
      { filePath: "src/config.ts", startLine: 21, endLine: 50 },
      { filePath: "src/config.ts", startLine: 51, endLine: 80 },
    ]);

    await planTask("fix null bug", context, makeOpts(provider));

    const userMsg = calls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    // Should contain the path once
    expect(userMsg).toContain("src/config.ts");
    // Should NOT contain line range annotations
    expect(userMsg).not.toMatch(/lines \d+[–-]\d+/);
    // Should only appear once (not duplicated)
    expect(userMsg.split("src/config.ts").length - 1).toBe(1);
  });

  it("caps context to at most 8 unique files", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Implement feature\n2. Run tests"]);

    const chunkPaths = Array.from({ length: 12 }, (_, i) => ({ filePath: `src/file${i}.ts` }));
    const context = makeContext(chunkPaths);

    await planTask("big refactor across many files", context, makeOpts(provider));

    const userMsg = calls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    // Count how many "src/fileN.ts" appear — should be 8 max
    const matches = userMsg.match(/src\/file\d+\.ts/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(8);
  });

  it("uses 'Files to consult:' framing (not 'Relevant files:')", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Do the thing"]);
    const context = makeContext([{ filePath: "src/main.ts" }]);

    await planTask("do the thing", context, makeOpts(provider));

    const userMsg = calls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("Files to consult:");
    expect(userMsg).not.toContain("Relevant files:");
  });

  it("falls back to 'No context provided.' when no chunks", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Do the thing"]);
    const context = makeContext([]);

    await planTask("do the thing", context, makeOpts(provider));

    const userMsg = calls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("No context provided.");
  });
});

// ---------------------------------------------------------------------------
// parseGoals end-to-end — filtering junk + capping
// ---------------------------------------------------------------------------

describe("planTask — parseGoals filters junk path echoes and caps goals", () => {
  it("filters out path-echo lines from model output", async () => {
    const mixedOutput = [
      "1. src/config/index.ts (lines 1–11)",
      "2. Add null check in parseConfig",
      "3. src/utils.ts",
      "4. Run tests to verify the fix",
    ].join("\n");

    const { provider } = makeRecordingProvider([mixedOutput]);
    const context = makeContext([]);

    const goals = await planTask("fix null bug", context, makeOpts(provider));

    // Only the two actionable goals should survive
    expect(goals).toHaveLength(2);
    expect(goals[0]?.description).toBe("Add null check in parseConfig");
    expect(goals[1]?.description).toBe("Run tests to verify the fix");
  });

  it("drops exact duplicate goal descriptions", async () => {
    const output = [
      "1. Add null check in parseConfig",
      "2. Add null check in parseConfig",
      "3. Run tests",
    ].join("\n");

    const { provider } = makeRecordingProvider([output]);
    const context = makeContext([]);

    const goals = await planTask("fix null bug", context, makeOpts(provider));

    // Deduped: only 2 unique descriptions
    expect(goals).toHaveLength(2);
    expect(goals[0]?.description).toBe("Add null check in parseConfig");
    expect(goals[1]?.description).toBe("Run tests");
  });

  it("caps at 3 for single-file context even if model returns more", async () => {
    const output = [
      "1. Read the existing code",
      "2. Add the null guard",
      "3. Update the type signature",
      "4. Write a unit test",
      "5. Run tests to confirm",
    ].join("\n");

    const { provider } = makeRecordingProvider([output]);
    const context = makeContext([{ filePath: "src/config.ts" }]);

    const goals = await planTask("fix null bug", context, makeOpts(provider));

    // Single file → cap 3
    expect(goals).toHaveLength(3);
  });

  it("caps at 5 for multi-file context even if model returns more", async () => {
    const output = [
      "1. Implement the auth middleware",
      "2. Update the router",
      "3. Add the JWT helper",
      "4. Refactor the config loader",
      "5. Write integration tests",
      "6. Update the README",
      "7. Run the full test suite",
    ].join("\n");

    const { provider } = makeRecordingProvider([output]);
    const context = makeContext([
      { filePath: "src/auth.ts" },
      { filePath: "src/router.ts" },
      { filePath: "src/jwt.ts" },
    ]);

    const bigTask =
      "Implement the new authentication flow across auth.ts, config.ts, and jwt.ts replacing passport";
    const goals = await planTask(bigTask, context, makeOpts(provider));

    // Multi-file → cap 5
    expect(goals).toHaveLength(5);
  });

  it("falls back to single goal when all lines are junk paths", async () => {
    const junkOutput = [
      "1. src/config/index.ts (lines 1–11)",
      "2. src/utils.ts",
      "3. utils/helpers",
    ].join("\n");

    const { provider } = makeRecordingProvider([junkOutput]);
    const context = makeContext([]);

    const goals = await planTask("fix null bug", context, makeOpts(provider));

    // Falls back to the task itself as the single goal
    expect(goals).toHaveLength(1);
    expect(goals[0]?.description).toBe("fix null bug");
    expect(goals[0]?.status).toBe("pending");
  });

  it("returned goals all have correct shape", async () => {
    const output = "1. Add null check\n2. Run tests";
    const { provider } = makeRecordingProvider([output]);

    const goals = await planTask("fix it", makeContext([]), makeOpts(provider));

    for (const g of goals) {
      expect(typeof g.id).toBe("string");
      expect(typeof g.description).toBe("string");
      expect(g.status).toBe("pending");
    }
  });
});

// ---------------------------------------------------------------------------
// PLANNER_SYSTEM_PROMPT constraints (verified via the actual provider call)
// ---------------------------------------------------------------------------

describe("PLANNER_SYSTEM_PROMPT — tightened constraints", () => {
  it("system prompt contains 'sub-goals' (backward-compat)", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Do the thing"]);
    await planTask("task", makeContext([]), makeOpts(provider));
    const sysContent = calls[0]?.messages[0]?.content ?? "";
    expect(sysContent).toContain("sub-goals");
  });

  it("system prompt contains 'Do NOT output file paths or line ranges as goals'", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Do the thing"]);
    await planTask("task", makeContext([]), makeOpts(provider));
    const sysContent = calls[0]?.messages[0]?.content ?? "";
    expect(sysContent).toContain("Do NOT output file paths or line ranges as goals");
  });

  it("system prompt says prefer 1–3 sub-goals", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Do the thing"]);
    await planTask("task", makeContext([]), makeOpts(provider));
    const sysContent = calls[0]?.messages[0]?.content ?? "";
    expect(sysContent).toMatch(/[Pp]refer 1[–-]3/);
  });

  it("system prompt says maximum 5", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Do the thing"]);
    await planTask("task", makeContext([]), makeOpts(provider));
    const sysContent = calls[0]?.messages[0]?.content ?? "";
    expect(sysContent).toContain("maximum 5");
  });

  it("system prompt says goals must start with an action verb", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Do the thing"]);
    await planTask("task", makeContext([]), makeOpts(provider));
    const sysContent = calls[0]?.messages[0]?.content ?? "";
    expect(sysContent.toLowerCase()).toContain("action");
  });

  it("respects plannerPrompt override — does NOT use default prompt", async () => {
    const customPrompt = "Custom planner: list one step.";
    const { provider, calls } = makeRecordingProvider(["1. Do the custom thing"]);
    await planTask("task", makeContext([]), makeOpts(provider, { plannerPrompt: customPrompt }));
    const sysContent = calls[0]?.messages[0]?.content ?? "";
    expect(sysContent).toBe(customPrompt);
    expect(sysContent).not.toContain("Do NOT output file paths");
  });
});
