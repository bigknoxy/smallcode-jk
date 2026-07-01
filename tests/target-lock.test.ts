import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, runLoop } from "../src/agent/index.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import { applyBatch, isOnTargetPath, OFF_TARGET_EDIT_REJECTED } from "../src/edit/index.ts";
import type { EditBlock } from "../src/edit/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// ---------------------------------------------------------------------------
// Hard-reject off-target edits (drift enforcement).
//
// Dogfooding proved a 7b IGNORES the prompt-level "stay on target" instruction
// (off-task-drift guard, loop-off-task-drift.test.ts) — it edited an unrelated
// file 7x despite the prompt repeating "edit ONLY <target>" every turn. This is
// the enforcement version: applyBatch and the write_file tool path both
// physically refuse to write an edit whose effective path is not the
// confidently-pinned fix target, exactly like the existing anti-test-edit
// guard refuses test-file edits.
// ---------------------------------------------------------------------------

function sr(filePath: string): EditBlock {
  return { filePath, search: "const a = 1;", replace: "const a = 2;", format: "search-replace" };
}

function makeIO(disk: Record<string, string>) {
  const writes: Array<{ path: string; content: string }> = [];
  const readFile = async (p: string): Promise<string | null> => disk[p] ?? null;
  const writeFile = async (p: string, content: string): Promise<void> => {
    writes.push({ path: p, content });
    disk[p] = content;
  };
  return { readFile, writeFile, writes };
}

describe("isOnTargetPath", () => {
  it("matches identical paths", () => {
    expect(isOnTargetPath("src/calc.ts", "src/calc.ts")).toBe(true);
  });
  it("normalizes a leading ./ and backslashes", () => {
    expect(isOnTargetPath("./src/calc.ts", "src/calc.ts")).toBe(true);
    expect(isOnTargetPath("src\\calc.ts", "src/calc.ts")).toBe(true);
  });
  it("rescues a dot-flattened typo of the TARGET path", () => {
    // Model emitted the correctly-slashed path but the pinned target itself
    // is stored flattened (or vice versa) — either direction must resolve.
    expect(isOnTargetPath("src/calc.ts", "src.calc.ts")).toBe(true);
    expect(isOnTargetPath("src.calc.ts", "src/calc.ts")).toBe(true);
  });
  it("rejects a genuinely different file", () => {
    expect(isOnTargetPath("src/other.ts", "src/calc.ts")).toBe(false);
  });
});

describe("applyBatch — target-lock guard", () => {
  it("rejects an edit to a file other than targetPath: status error, no write", async () => {
    const { readFile, writeFile, writes } = makeIO({ "src/other.ts": "const a = 1;" });
    const batch = await applyBatch([sr("src/other.ts")], readFile, writeFile, {
      targetPath: "src/calc.ts",
    });
    expect(batch.allApplied).toBe(false);
    expect(batch.results[0]!.status).toBe("error");
    expect(batch.results[0]!.error).toContain(OFF_TARGET_EDIT_REJECTED);
    expect(batch.results[0]!.error).toContain("src/calc.ts");
    expect(writes).toHaveLength(0);
  });

  it("still applies an edit to the target file itself", async () => {
    const { readFile, writeFile, writes } = makeIO({ "src/calc.ts": "const a = 1;" });
    const batch = await applyBatch([sr("src/calc.ts")], readFile, writeFile, {
      targetPath: "src/calc.ts",
    });
    expect(batch.allApplied).toBe(true);
    expect(batch.results[0]!.status).toBe("applied");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("src/calc.ts");
  });

  it("rejects ONLY the off-target block in a mixed batch; the on-target edit applies", async () => {
    const { readFile, writeFile, writes } = makeIO({
      "src/calc.ts": "const a = 1;",
      "src/other.ts": "const a = 1;",
    });
    const batch = await applyBatch([sr("src/calc.ts"), sr("src/other.ts")], readFile, writeFile, {
      targetPath: "src/calc.ts",
    });
    expect(batch.allApplied).toBe(false);
    const byPath = Object.fromEntries(batch.results.map((r) => [r.filePath, r.status]));
    expect(byPath["src/calc.ts"]).toBe("applied");
    expect(byPath["src/other.ts"]).toBe("error");
    expect(writes.map((w) => w.path)).toEqual(["src/calc.ts"]);
  });

  it("does not enforce when no targetPath is given (opts omitted)", async () => {
    const { readFile, writeFile, writes } = makeIO({ "src/other.ts": "const a = 1;" });
    const batch = await applyBatch([sr("src/other.ts")], readFile, writeFile);
    expect(batch.allApplied).toBe(true);
    expect(writes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Loop-level: both write paths (FILE:/PATCH: -> applyBatch, and
// TOOL: write_file -> tools.ts) must be covered.
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

function makeSequentialProvider(responses: string[]): Provider {
  let call = 0;
  return {
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => {
      const text = responses[Math.min(call, responses.length - 1)] ?? "";
      call++;
      return {
        rawContent: text,
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      };
    },
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "", done: true };
    },
  };
}

const TARGET_PATH = "src/calc.ts";
const BUGGY_SOURCE = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
const FIXED_SOURCE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

function makeTargetContext(): ContextBundle {
  return {
    chunks: [
      { filePath: TARGET_PATH, startLine: 1, endLine: 3, content: BUGGY_SOURCE, estimatedTokens: 20, pinned: true },
    ],
    totalTokens: 20,
    tokenBudget: 4096,
    truncated: false,
    query: "fix add in src/calc.ts",
    targetFile: { path: TARGET_PATH, lineCount: 3, format: "full" },
  };
}

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `smallcode-targetlock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
  await writeFile(join(testDir, "src", "calc.ts"), BUGGY_SOURCE, "utf-8");
  await writeFile(
    join(testDir, "tests", "calc.test.ts"),
    'import { test, expect } from "bun:test";\nimport { add } from "../src/calc.ts";\ntest("adds two numbers", () => expect(add(2, 3)).toBe(5));\n',
    "utf-8",
  );
});

afterEach(async () => {
  delete process.env["SMALLCODE_TARGET_LOCK"];
  await rm(testDir, { recursive: true, force: true });
});

describe("target-lock — write_file TOOL path", () => {
  it("rejects a write_file to an off-target file (fix-mode: baseline red + confident target)", async () => {
    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 2, bestOfN: 1 };
    const state = createState(config, "Fix add() in src/calc.ts so the failing test passes");
    state.goals = [{ id: "goal-1", description: "Fix add in src/calc.ts", status: "pending" }];

    const responses = [
      // Turn 1: wanders — attempts to write an UNRELATED file via TOOL: write_file
      // instead of fixing the target. Must be rejected, not written.
      `TOOL: write_file {"path": "src/other.ts", "content": "export const x = 1;\\n"}\nTOOL: finish {"summary": "done"}`,
    ];
    const provider = makeSequentialProvider(responses);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeTargetContext(),
    );

    const turn1 = finalState.turns[0]!;
    const rejection = turn1.toolResults.find((r) => r.name === "write_file");
    expect(rejection?.success).toBe(false);
    expect(rejection?.error).toContain("src/calc.ts");
    expect(rejection?.error).toContain("src/other.ts");
    expect(rejection?.error).toContain("REJECTED");

    // The off-target file was never actually written to disk.
    const other = Bun.file(join(testDir, "src", "other.ts"));
    expect(await other.exists()).toBe(false);
  });

  it("applies a write_file to the target file itself, and the oracle runs normally", async () => {
    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 2, bestOfN: 1 };
    const state = createState(config, "Fix add() in src/calc.ts so the failing test passes");
    state.goals = [{ id: "goal-1", description: "Fix add in src/calc.ts", status: "pending" }];

    const responses = [
      `TOOL: write_file {"path": "src/calc.ts", "content": ${JSON.stringify(FIXED_SOURCE)}}\nTOOL: finish {"summary": "fixed"}`,
    ];
    const provider = makeSequentialProvider(responses);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeTargetContext(),
    );

    // On-target write_file succeeded, oracle went green, loop solved.
    expect(finalState.status).toBe("done");
    expect(finalState.verified).toBe(true);
    const onDisk = await Bun.file(join(testDir, "src", "calc.ts")).text();
    expect(onDisk).toBe(FIXED_SOURCE);
  });

  it("SMALLCODE_TARGET_LOCK=0 disables enforcement — the off-target write_file is applied", async () => {
    process.env["SMALLCODE_TARGET_LOCK"] = "0";
    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 2, bestOfN: 1 };
    const state = createState(config, "Fix add() in src/calc.ts so the failing test passes");
    state.goals = [{ id: "goal-1", description: "Fix add in src/calc.ts", status: "pending" }];

    const responses = [
      `TOOL: write_file {"path": "src/other.ts", "content": "export const x = 1;\\n"}\nTOOL: finish {"summary": "done"}`,
    ];
    const provider = makeSequentialProvider(responses);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeTargetContext(),
    );

    const turn1 = finalState.turns[0]!;
    const result = turn1.toolResults.find((r) => r.name === "write_file");
    expect(result?.success).toBe(true);
    const other = Bun.file(join(testDir, "src", "other.ts"));
    expect(await other.exists()).toBe(true);
  });

  it("stable run-level lock: per-turn retrieval drift cannot move the enforcement target", async () => {
    // Reproduces the #80 follow-up dogfood bug: turn 1 establishes the lock on
    // the confidently-pinned target (src/calc.ts). Turns 2+ simulate retrieval
    // DRIFT — `getContext` re-pins `context.targetFile` onto a DIFFERENT file
    // each turn, exactly like the live dogfood where an off-target edit
    // entering recent-history/context caused retrieval to re-pin onto it. The
    // buggy version bound `lockTargetPath` to the live per-turn
    // `context.targetFile`, so it would "follow" the drift and reject nothing.
    // The fix binds to `state.lockedTargetPath`, captured ONCE on turn 1 and
    // never overwritten, so every off-target write in turns 2+ must still be
    // REJECTED against the ORIGINAL target even though `context.targetFile`
    // itself has drifted. This is genuine RANDOM drift — a DIFFERENT
    // off-target file each turn (src/other.ts, then src/another.ts) — which
    // must never retarget the lock (that's the mis-pin self-correction guard
    // in loop-target-lock-retarget.test.ts: it only fires on a PERSISTENT
    // streak at the SAME off-target path).
    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 3, bestOfN: 1 };
    const state = createState(config, "Fix add() in src/calc.ts so the failing test passes");
    state.goals = [{ id: "goal-1", description: "Fix add in src/calc.ts", status: "pending" }];

    const responses = [
      // Turn 1: on-target edit (still buggy — does NOT fix the test, so the
      // loop keeps running) — this is the turn that ESTABLISHES the lock.
      `TOOL: write_file {"path": "src/calc.ts", "content": "export function add(a, b) { return a - b; }\\n"}`,
      // Turn 2: wanders to an UNRELATED file while retrieval has (per the mock
      // below) re-pinned context.targetFile onto that SAME unrelated file.
      `TOOL: write_file {"path": "src/other.ts", "content": "export const x = 1;\\n"}`,
      // Turn 3: wanders to a DIFFERENT unrelated file (not the same one as
      // turn 2) — the streak resets, so the lock must still hold from turn 1.
      `TOOL: write_file {"path": "src/another.ts", "content": "export const x = 2;\\n"}`,
    ];
    const provider = makeSequentialProvider(responses);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    let calls = 0;
    const driftingGetContext = async (_goal: string): Promise<ContextBundle> => {
      calls += 1;
      if (calls === 1) return makeTargetContext(); // pins src/calc.ts
      // Simulated drift: retrieval re-pins onto the file the model touched off-
      // target last turn, exactly as pickTargetFunction does once that file is
      // in recent-history/context.
      return {
        chunks: [],
        totalTokens: 0,
        tokenBudget: 4096,
        truncated: false,
        query: "fix add",
        targetFile: { path: calls === 2 ? "src/other.ts" : "src/another.ts", lineCount: 1, format: "full" },
      };
    };

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      driftingGetContext,
    );

    expect(calls).toBeGreaterThanOrEqual(3);
    // The lock captured on turn 1 and never overwritten — random drift across
    // DIFFERENT off-target files never crosses the same-path retarget streak.
    expect(finalState.lockedTargetPath).toBe(TARGET_PATH);

    // Turn 1: on-target write_file was NOT rejected.
    const turn1Result = finalState.turns[0]!.toolResults.find((r) => r.name === "write_file");
    expect(turn1Result?.success).toBe(true);

    // Turns 2 and 3: off-target writes REJECTED against the STABLE original
    // target, even though context.targetFile drifted each turn.
    const turn2Result = finalState.turns[1]!.toolResults.find((r) => r.name === "write_file");
    expect(turn2Result?.success).toBe(false);
    expect(turn2Result?.error).toContain(TARGET_PATH);
    expect(turn2Result?.error).toContain("src/other.ts");
    expect(turn2Result?.error).toContain("REJECTED");

    const turn3Result = finalState.turns[2]!.toolResults.find((r) => r.name === "write_file");
    expect(turn3Result?.success).toBe(false);
    expect(turn3Result?.error).toContain(TARGET_PATH);
    expect(turn3Result?.error).toContain("src/another.ts");
    expect(turn3Result?.error).toContain("REJECTED");

    // Neither off-target file was ever actually written to disk.
    const other = Bun.file(join(testDir, "src", "other.ts"));
    expect(await other.exists()).toBe(false);
    const another = Bun.file(join(testDir, "src", "another.ts"));
    expect(await another.exists()).toBe(false);
  });

  it("no confident targetFile -> nothing is blocked", async () => {
    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 2, bestOfN: 1 };
    const state = createState(config, "Fix add() in src/calc.ts so the failing test passes");
    state.goals = [{ id: "goal-1", description: "Fix add in src/calc.ts", status: "pending" }];

    const responses = [
      `TOOL: write_file {"path": "src/other.ts", "content": "export const x = 1;\\n"}\nTOOL: finish {"summary": "done"}`,
    ];
    const provider = makeSequentialProvider(responses);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const noTargetContext: ContextBundle = {
      chunks: [],
      totalTokens: 0,
      tokenBudget: 4096,
      truncated: false,
      query: "fix add",
      // No targetFile — low-confidence/multi-file retrieval. Guard must not fire.
    };

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => noTargetContext,
    );

    const turn1 = finalState.turns[0]!;
    const result = turn1.toolResults.find((r) => r.name === "write_file");
    expect(result?.success).toBe(true);
    const other = Bun.file(join(testDir, "src", "other.ts"));
    expect(await other.exists()).toBe(true);
  });
});
