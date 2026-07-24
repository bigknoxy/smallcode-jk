import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, runLoop } from "../src/agent/index.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// ---------------------------------------------------------------------------
// Gate: operator/statement repair must SKIP a compile/load-error baseline.
//
// Dogfood 2026-07-07: a `smallcode run` add-a-function task whose failing test
// imported a not-yet-implemented symbol (`Export named 'wilsonCI' not found`)
// caused mutation-repair to fire and churn the full oracle over every operator
// flip in the pinned file — ~36 suite runs across two rungs, all futile: no
// operator flip can conjure a missing export or fix a syntax error. This test
// pins the fix: when the baseline red is a load error, both repair passes are
// skipped. The differential is exact — an IDENTICAL operator-fixable bug fires
// mutation-repair without the load error and is skipped WITH it.
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

const TARGET = "src/eq.ts";
// The buggy operator (`!==`) that a single flip to `===` fixes — mutation-repair
// territory. eq(2,2) returns false at baseline; the target test wants true.
const BUGGY = `export function eq(a, b) {
  return a !== b;
}
`;
// The model "fixes" nothing (re-emits the same buggy body), so the run reaches
// the repair passes UNSOLVED with the operator bug still present.
const MODEL_EDIT = `FILE: ${TARGET}\n\`\`\`ts\nexport function eq(a, b) {\n  return a !== b;\n}\n\`\`\`\nTOOL: finish {"summary": "done"}`;

function makeContext(): ContextBundle {
  return {
    chunks: [
      { filePath: TARGET, startLine: 1, endLine: 3, content: BUGGY, estimatedTokens: 20, pinned: true },
    ],
    totalTokens: 20,
    tokenBudget: 4096,
    truncated: false,
    query: "fix eq in src/eq.ts",
    targetFile: { path: TARGET, lineCount: 3, format: "full" },
  };
}

let testDir: string;
let priorMut: string | undefined;

async function setup(testBody: string): Promise<void> {
  testDir = join(tmpdir(), `smallcode-loaderr-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
  await writeFile(join(testDir, "src", "eq.ts"), BUGGY, "utf-8");
  await writeFile(join(testDir, "tests", "eq.test.ts"), testBody, "utf-8");
}

function makeRun() {
  const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 2, bestOfN: 1 };
  const state = createState(config, "Fix eq() in src/eq.ts");
  state.goals = [{ id: "goal-1", description: "Fix eq in src/eq.ts", status: "pending" }];
  return {
    state,
    statePath: join(testDir, "state.json"),
    deps: {
      provider: makeProvider(MODEL_EDIT),
      profile: makeProfile(),
      reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
      config,
    },
  };
}

beforeEach(() => {
  priorMut = process.env["SMALLCODE_MUTATION_REPAIR"];
  process.env["SMALLCODE_MUTATION_REPAIR"] = "1";
});
afterEach(async () => {
  if (priorMut === undefined) delete process.env["SMALLCODE_MUTATION_REPAIR"];
  else process.env["SMALLCODE_MUTATION_REPAIR"] = priorMut;
  await rm(testDir, { recursive: true, force: true });
});

describe("repair load-error gate", () => {
  it("FIRES mutation-repair on an assertion-red baseline (positive control)", async () => {
    // A clean assertion failure: the suite loads, eq(2,2) is false, test wants true.
    await setup(
      'import { test, expect } from "bun:test";\nimport { eq } from "../src/eq.ts";\n' +
        'test("eq is true for equal args", () => {\n  expect(eq(2, 2)).toBe(true);\n});\n',
    );
    const { state, statePath, deps } = makeRun();
    const finalState = await runLoop(state, statePath, deps, async () => makeContext());

    // Operator brute-force flipped `!==`→`===` and the oracle went green.
    expect(finalState.verified).toBe(true);
    expect(finalState.turns.at(-1)?.mutationRepair).toBeDefined();
  });

  it("SKIPS mutation-repair when the baseline red is a load error (missing export)", async () => {
    const errSpy = spyOn(console, "error");
    // Same operator-fixable bug, but the test ALSO imports a symbol src/eq.ts does
    // not export → the suite fails to LOAD (`Export named 'neq' not found`). No
    // operator flip can satisfy that, so the repair pass must not fire.
    await setup(
      'import { test, expect } from "bun:test";\nimport { eq, neq } from "../src/eq.ts";\n' +
        'test("eq is true for equal args", () => {\n  expect(eq(2, 2)).toBe(true);\n  expect(neq(1, 2)).toBe(true);\n});\n',
    );
    const { state, statePath, deps } = makeRun();
    const finalState = await runLoop(state, statePath, deps, async () => makeContext());

    // Gate held: run stayed UNSOLVED and no mutation-repair turn was appended.
    expect(finalState.verified).not.toBe(true);
    expect(finalState.turns.some((t) => t.mutationRepair !== undefined)).toBe(false);
    // And the skip was logged for observability.
    const loggedSkip = errSpy.mock.calls.some((c) =>
      String(c[0]).includes("skipped operator/statement/literal/boolean repair"),
    );
    expect(loggedSkip).toBe(true);
    errSpy.mockRestore();
  });
});
