import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, runLoop } from "../src/agent/index.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  StreamChunk,
} from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// ---------------------------------------------------------------------------
// Dogfood #3 (2026-07-08) repro: `smallcode run --escalation` on a real
// parseArgs bug ended UNSOLVED and left src/cli/args.ts BROKEN on disk (suite
// 2 red → 6 red). The final-state guard (default ON) did NOT revert — no log,
// finalStateReverted null. The guard has never been tested with the default-on
// mutation-repair pass, which fired on the same file right before the guard.
//
// This test isolates the runLoop-level path: BOTH SMALLCODE_MUTATION_REPAIR and
// SMALLCODE_FINAL_STATE_GUARD on, a fix-mode baseline with a locked target, the
// model leaves an on-target edit that REGRESSES a consumer test, and NO operator
// flip in the (operator-less) rewrite can green the suite so mutation-repair
// exhausts and the guard is the last line of defense. It MUST revert to pristine.
// ---------------------------------------------------------------------------

const TARGET = "src/classify.ts";

// Pristine (seeded bug): the ZERO branch returns the wrong STRING ("bad" vs the
// expected "zero"). Crucially the bug is NOT operator-shaped — no comparison flip
// in ANY base can green it, so operator-mutation repair is guaranteed to exhaust
// and hand off to the guard. One consumer test (zero) is red at baseline; the
// suite LOADS (assertion failure, not a compile/load error) so mutation-repair is
// eligible (fixModeBaseline true, loadError false).
const PRISTINE = `export function classify(n) {
  if (n > 0) return "pos";
  if (n === 0) return "bad";
  return "neg";
}
`;

// The model's "fix": an operator-LESS rewrite that returns "neg" always — WORSE
// (now the pos AND zero tests fail → 2 red vs baseline's 1). No comparison
// operator remains in the target function, and no flip in the pristine base greens
// the wrong-string bug either, so operator-mutation repair exhausts. The guard
// must catch this and revert to pristine.
const MODEL_BODY = `export function classify(n) {
  return "neg";
}
`;
const MODEL_EDIT = `FILE: ${TARGET}\n\`\`\`ts\n${MODEL_BODY}\`\`\`\nTOOL: finish {"summary": "done"}`;

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

function makeContext(): ContextBundle {
  return {
    chunks: [
      {
        filePath: TARGET,
        startLine: 1,
        endLine: 4,
        content: PRISTINE,
        estimatedTokens: 20,
        pinned: true,
      },
    ],
    totalTokens: 20,
    tokenBudget: 4096,
    truncated: false,
    query: `fix classify in ${TARGET}`,
    targetFile: { path: TARGET, lineCount: 4, format: "full" },
  };
}

let testDir: string;
let priorMut: string | undefined;
let priorGuard: string | undefined;

async function setup(): Promise<void> {
  testDir = join(
    tmpdir(),
    `smallcode-guard-mut-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
  await writeFile(join(testDir, "src", "classify.ts"), PRISTINE, "utf-8");
  await writeFile(
    join(testDir, "tests", "classify.test.ts"),
    'import { test, expect } from "bun:test";\nimport { classify } from "../src/classify.ts";\n' +
      'test("pos", () => {\n  expect(classify(5)).toBe("pos");\n});\n' +
      'test("zero", () => {\n  expect(classify(0)).toBe("zero");\n});\n' +
      'test("neg", () => {\n  expect(classify(-1)).toBe("neg");\n});\n',
    "utf-8",
  );
}

function makeRun() {
  const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 2, bestOfN: 1 };
  const state = createState(config, `Fix classify() in ${TARGET}`);
  state.goals = [{ id: "goal-1", description: `Fix classify in ${TARGET}`, status: "pending" }];
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
  priorGuard = process.env["SMALLCODE_FINAL_STATE_GUARD"];
  process.env["SMALLCODE_MUTATION_REPAIR"] = "1";
  process.env["SMALLCODE_FINAL_STATE_GUARD"] = "1";
});
afterEach(async () => {
  if (priorMut === undefined) delete process.env["SMALLCODE_MUTATION_REPAIR"];
  else process.env["SMALLCODE_MUTATION_REPAIR"] = priorMut;
  if (priorGuard === undefined) delete process.env["SMALLCODE_FINAL_STATE_GUARD"];
  else process.env["SMALLCODE_FINAL_STATE_GUARD"] = priorGuard;
  await rm(testDir, { recursive: true, force: true });
});

describe("final-state guard + default-on mutation-repair (dogfood #3 repro)", () => {
  it("never leaves the repo worse than found when mutation-repair can't green a regressing edit", async () => {
    await setup();
    const { state, statePath, deps } = makeRun();
    const finalState = await runLoop(state, statePath, deps, async () => makeContext());

    // Run ended UNSOLVED (the model's edit is worse, mutation-repair exhausted).
    expect(finalState.verified).not.toBe(true);
    // The GUARANTEE, mechanism-agnostic: whichever layer catches it (per-turn
    // revert-on-regression here, the final-state guard when a throw bypasses that),
    // the repo must be restored to exactly how it was found — never left worse.
    const onDisk = await readFile(join(testDir, "src", "classify.ts"), "utf-8");
    expect(onDisk).toBe(PRISTINE);
  });
});
