import { describe, expect, it } from "bun:test";
import type { PlannerOptions } from "../src/agent/planner.ts";
import { isInstructionEcho, planTask } from "../src/agent/planner.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  StreamChunk,
} from "../src/provider/types.ts";

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

function makeContext(): ContextBundle {
  return {
    chunks: [
      { filePath: "src/slug.ts", startLine: 1, endLine: 6, content: "x", estimatedTokens: 5 },
    ],
    totalTokens: 5,
    tokenBudget: 2048,
    truncated: false,
    query: "test",
  };
}

function makeProvider(response: string): Provider {
  return {
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
      rawContent: response,
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    }),
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "", done: true };
    },
  };
}

function makeOpts(provider: Provider): PlannerOptions {
  return { provider, modelId: "test-model", profile: makeProfile(), repoRoot: "/tmp/test" };
}

// ---------------------------------------------------------------------------
// isInstructionEcho — reject the planner echoing its own instructions (#7)
// ---------------------------------------------------------------------------

describe("isInstructionEcho — reject instruction echoes", () => {
  it("rejects the exact parroted goal seen in the v1.2.0 smoke", () => {
    const echoed =
      'Each sub-goal must be a concrete ACTION starting with an action verb (e.g., Add, Fix, Implement, Write, Update, Remove, Refactor, Run). So each line must start with a verb (capitalized) followed by description. Must be specific: "Add ...".';
    expect(isInstructionEcho(echoed)).toBe(true);
  });

  it("rejects 'action verb' meta-vocabulary", () => {
    expect(isInstructionEcho("Start each goal with an action verb")).toBe(true);
  });

  it("rejects 'sub-goal' meta-vocabulary", () => {
    expect(isInstructionEcho("Output a numbered list of sub-goals")).toBe(true);
  });

  it("rejects literal format placeholders", () => {
    expect(isInstructionEcho("<action verb> <specific thing> in <file>")).toBe(true);
  });

  it("rejects the copied example verb list", () => {
    expect(isInstructionEcho("Add, Fix, Implement the changes")).toBe(true);
  });

  it("rejects 'do NOT copy these placeholders'", () => {
    expect(isInstructionEcho("Do not copy these placeholders literally")).toBe(true);
  });
});

describe("isInstructionEcho — accept genuine goals", () => {
  const realGoals = [
    "Add a null check in parseConfig",
    "Fix the off-by-one in loop.ts",
    "Implement getActiveProfile in src/config/resolve.ts",
    "Run tests to verify", // overlaps the format line but carries no markers
    "Update the regex in slug.ts to lowercase and strip punctuation",
    "Refactor parseGoals to remove the slice cap",
    "Write a test for the empty-string case",
  ];
  for (const g of realGoals) {
    it(`accepts: ${g}`, () => {
      expect(isInstructionEcho(g)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// planTask integration — echoed goals are filtered out of the plan
// ---------------------------------------------------------------------------

describe("planTask drops instruction-echo goals", () => {
  it("filters the parroted instruction goal, keeps the real ones", async () => {
    const response = [
      "1. Each sub-goal must be a concrete ACTION starting with an action verb (e.g., Add, Fix, Implement)",
      "2. Update slugify in src/slug.ts to lowercase, strip punctuation, and collapse spaces",
      "3. Run tests to verify",
    ].join("\n");

    const goals = await planTask("Fix slugify", makeContext(), makeOpts(makeProvider(response)));

    const descs = goals.map((g) => g.description);
    expect(descs).not.toContain(
      "Each sub-goal must be a concrete ACTION starting with an action verb (e.g., Add, Fix, Implement)",
    );
    expect(descs).toContain(
      "Update slugify in src/slug.ts to lowercase, strip punctuation, and collapse spaces",
    );
    expect(descs).toContain("Run tests to verify");
    expect(goals).toHaveLength(2);
  });

  it("falls back to the task itself when EVERY goal is an instruction echo", async () => {
    const response = [
      "1. Each sub-goal must be a concrete ACTION starting with an action verb",
      "2. Output ONLY a numbered list of sub-goals, no prose",
    ].join("\n");

    const goals = await planTask(
      "Fix the parser bug",
      makeContext(),
      makeOpts(makeProvider(response)),
    );

    expect(goals).toHaveLength(1);
    expect(goals[0]?.description).toBe("Fix the parser bug");
  });
});
