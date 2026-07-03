import { afterEach, beforeEach, expect, test } from "bun:test";
import { runTask } from "../src/eval/task-runner.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import type { LoopDependencies } from "../src/agent/loop.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  StreamChunk,
} from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// Integration test for run-level Best-of-N wired into the eval task-runner.
//
// NO module mocks (bun's mock.module is process-wide and leaks into other test
// files). Instead we drive the REAL agent loop + REAL deterministic grader with
// a fake scripted Provider. The provider hands the WINNING-temperature attempt a
// full-file edit that fixes add(); every other attempt gets a no-edit finish, so
// the bug survives and the real `bun test` oracle returns red. This exercises the
// true first-deterministic-green short-circuit and attemptsUsed accounting with
// no model and zero leak.

const GOOD = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const BUG = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";

// Turn temperatures seen (one per attempt; planner calls are excluded).
const tempsSeen: number[] = [];
// Temperature whose attempt produces a passing solution. A value no swept temp
// equals ("none") means every attempt stays buggy.
let winningTemp = Number.NaN;

function isPlannerCall(req: CompletionRequest): boolean {
  const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
  return sys.includes("plans tasks as ordered sub-goals");
}

// Fake provider: returns a 1-goal plan for the planner call; for the agent turn,
// returns a full-file fix only when this attempt's temperature is the winner.
function makeProvider(): Provider {
  const respond = (req: CompletionRequest): string => {
    if (isPlannerCall(req)) return "1. Make add return a + b";
    const temp = req.temperature ?? Number.NaN;
    tempsSeen.push(temp);
    if (temp === winningTemp) {
      return [
        "Here is the fix:",
        "FILE: src/solution.ts",
        "```ts",
        GOOD.trimEnd(),
        "```",
        'TOOL: finish {"summary": "fixed add"}',
      ].join("\n");
    }
    return 'No change needed.\nTOOL: finish {"summary": "done"}';
  };
  return {
    complete: async (req: CompletionRequest): Promise<CompletionResponse> => ({
      rawContent: respond(req),
      model: "test-model",
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
      finishReason: "stop",
    }),
    stream: async function* (req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: respond(req), done: true };
    },
  };
}

function makeProfile(): ModelProfile {
  return {
    id: "test-model",
    label: "Test Model",
    contextWindow: 8192,
    samplingDefaults: { temperature: 1.0, top_p: 0.9, top_k: -1, max_tokens: 512 },
    supportsGrammar: false,
    supportsJsonSchema: false,
  };
}

function makeTask() {
  return {
    id: "bon-task",
    desc: "Make the add function return a + b",
    setup: {
      files: {
        "src/solution.ts": BUG,
        "tests/solution.test.ts":
          'import { test, expect } from "bun:test";\n' +
          'import { add } from "../src/solution.ts";\n' +
          'test("add", () => { expect(add(1, 2)).toBe(3); });\n',
        "package.json": JSON.stringify({
          name: "bon-fixture",
          module: "src/solution.ts",
          type: "module",
        }),
      },
    },
    graders: [{ type: "deterministic_tests", required: [], command: "bun test" }],
    trackedMetrics: [],
  } as const;
}

function makeOpts(bestOfN: number) {
  const agentConfig: AgentConfig = {
    repoRoot: "/tmp/unused",
    modelId: "test-model",
    maxTurns: 2,
    bestOfN: 1,
  };
  const loopDeps: LoopDependencies = {
    provider: makeProvider(),
    profile: makeProfile(),
    reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
    config: agentConfig,
  };
  return {
    trialsPerTask: 1,
    fixturesRoot: "/tmp/unused-fixtures",
    agentConfig,
    loopDeps,
    bestOfN,
  };
}

// Isolate BoN mechanics from harness-side operator-mutation repair (default ON).
// These tests drive the REAL loop with a buggy `add()` (`a - b`); with repair on,
// the post-loop pass would flip `-`→`+` and rescue every attempt, short-circuiting
// the temp-sweep this test exists to exercise. Repair has its own tests — disable
// it here so BoN behavior is measured in isolation.
const priorMutationRepair = process.env["SMALLCODE_MUTATION_REPAIR"];
beforeEach(() => {
  tempsSeen.length = 0;
  winningTemp = Number.NaN;
  process.env["SMALLCODE_MUTATION_REPAIR"] = "0";
});
afterEach(() => {
  if (priorMutationRepair === undefined) delete process.env["SMALLCODE_MUTATION_REPAIR"];
  else process.env["SMALLCODE_MUTATION_REPAIR"] = priorMutationRepair;
});

test("BoN trial short-circuits on the first deterministic-green attempt", async () => {
  winningTemp = 1.0; // middle (index 1) swept temp produces a passing add()
  const res = await runTask(makeTask() as any, makeOpts(3));

  const trial = res.trials[0]!;
  expect(trial.passed).toBe(true);
  expect(trial.attemptsUsed).toBe(2); // attempt 0 (red) + 1 (green); index 2 never runs
  expect(tempsSeen).toEqual([0.7, 1.0]); // swept temps, stopped after the winner
  expect(res.bestOfN).toBe(3);
  expect(res.avgAttemptsUsed).toBe(2);
  expect(res.passAt1).toBe(1);
}, 60_000);

test("BoN trial runs all N attempts and fails when none go green", async () => {
  winningTemp = 99; // no swept temp matches -> every attempt stays buggy
  const res = await runTask(makeTask() as any, makeOpts(3));

  const trial = res.trials[0]!;
  expect(trial.passed).toBe(false);
  expect(trial.attemptsUsed).toBe(3);
  expect(tempsSeen).toEqual([0.7, 1.0, 1.3]);
  expect(res.avgAttemptsUsed).toBe(3);
  expect(res.passAt1).toBe(0);
}, 60_000);

test("bestOfN<=1 leaves the single-shot path untouched (no BoN fields)", async () => {
  winningTemp = 1.0; // single-shot uses the profile default temperature (1.0)
  const res = await runTask(makeTask() as any, makeOpts(1));

  const trial = res.trials[0]!;
  expect(trial.passed).toBe(true);
  expect(trial.attemptsUsed).toBeUndefined(); // single-shot does not stamp it
  expect(res.bestOfN).toBeUndefined();
  expect(res.avgAttemptsUsed).toBeUndefined();
}, 60_000);
