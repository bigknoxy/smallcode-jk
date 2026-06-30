import { mock, test, expect, beforeEach } from "bun:test";

// Mock the agent loop so we can drive Best-of-N control flow without a model.
// Each fake runLoop records the temperature it was handed and returns the state.
const tempsSeen: number[] = [];
const modelIdsSeen: (string | undefined)[] = [];
const profileIdsSeen: (string | undefined)[] = [];
mock.module("../src/agent/loop.ts", () => ({
  runLoop: async (state: any, _sp: string, deps: any) => {
    tempsSeen.push(deps.samplingOverride?.temperature);
    modelIdsSeen.push(state.modelId);
    profileIdsSeen.push(deps.profile?.id);
    return state;
  },
}));

const { runBestOfNLoop, defaultTemperatures } = await import("../src/agent/bestofn-loop.ts");

const rung = (id: string) => ({ id, provider: { name: id } as any, profile: { id } as any });

function makeOpts(n: number, passOnAttempt: number | null) {
  const setupCalls: number[] = [];
  const verifyCalls: number[] = [];
  return {
    setupCalls,
    verifyCalls,
    opts: {
      n,
      setup: async (i: number) => {
        setupCalls.push(i);
        return {
          state: { attempt: i } as any,
          statePath: `/tmp/s${i}`,
          getContext: async () => ({}) as any,
        };
      },
      verify: async (i: number) => {
        verifyCalls.push(i);
        return passOnAttempt !== null && i === passOnAttempt;
      },
      deps: {} as any,
    },
  };
}

beforeEach(() => {
  tempsSeen.length = 0;
  modelIdsSeen.length = 0;
  profileIdsSeen.length = 0;
});

// makeOpts variant that injects an escalation ladder + a base modelId/profile.
function makeEscalationOpts(n: number, passOnAttempt: number | null, models: any[]) {
  return {
    n,
    models,
    setup: async (i: number) => ({
      state: { attempt: i, modelId: "base-model" } as any,
      statePath: `/tmp/s${i}`,
      getContext: async () => ({}) as any,
    }),
    verify: async (i: number) => passOnAttempt !== null && i === passOnAttempt,
    deps: { profile: { id: "base-model" } } as any,
  };
}

test("defaultTemperatures: n=1 is [1.0]", () => {
  expect(defaultTemperatures(1)).toEqual([1.0]);
});

test("defaultTemperatures: n=3 sweeps [0.7,1.0,1.3], stays in [0.7,1.3]", () => {
  expect(defaultTemperatures(3)).toEqual([0.7, 1.0, 1.3]);
  const t = defaultTemperatures(5);
  expect(t[0]).toBe(0.7);
  expect(t[t.length - 1]).toBe(1.3);
  expect(Math.min(...t)).toBeGreaterThanOrEqual(0.7); // never below VibeThinker floor
});

test("stops at first green and reports the winning attempt", async () => {
  const { opts, setupCalls, verifyCalls } = makeOpts(3, 1); // passes on attempt index 1
  const res = await runBestOfNLoop(opts);
  expect(res.passed).toBe(true);
  expect(res.winningAttempt).toBe(1);
  expect(res.attemptsUsed).toBe(2); // attempt 2 (index 2) never runs
  expect(setupCalls).toEqual([0, 1]);
  expect(verifyCalls).toEqual([0, 1]);
});

test("varies temperature across attempts", async () => {
  const { opts } = makeOpts(3, null); // never passes -> runs all 3
  await runBestOfNLoop(opts);
  expect(tempsSeen).toEqual([0.7, 1.0, 1.3]);
});

test("reports failure when no attempt passes", async () => {
  const { opts, setupCalls } = makeOpts(3, null);
  const res = await runBestOfNLoop(opts);
  expect(res.passed).toBe(false);
  expect(res.winningAttempt).toBeNull();
  expect(res.attemptsUsed).toBe(3);
  expect(setupCalls).toEqual([0, 1, 2]);
});

// ---------------------------------------------------------------------------
// R1 model-escalation ladder
// ---------------------------------------------------------------------------

test("R1: attempt i runs with models[i] — retargets state.modelId AND deps.profile", async () => {
  const res = await runBestOfNLoop(makeEscalationOpts(3, null, [rung("3b"), rung("3b"), rung("7b")]));
  expect(modelIdsSeen).toEqual(["3b", "3b", "7b"]);
  expect(profileIdsSeen).toEqual(["3b", "3b", "7b"]);
  expect(res.modelsUsed).toEqual(["3b", "3b", "7b"]);
});

test("R1: ladder index clamps to the last rung past its length", async () => {
  await runBestOfNLoop(makeEscalationOpts(4, null, [rung("3b"), rung("7b")]));
  expect(modelIdsSeen).toEqual(["3b", "7b", "7b", "7b"]);
});

test("R1: winningModelId = the rung that resolved", async () => {
  const res = await runBestOfNLoop(makeEscalationOpts(3, 2, [rung("3b"), rung("3b"), rung("7b")]));
  expect(res.passed).toBe(true);
  expect(res.winningAttempt).toBe(2);
  expect(res.winningModelId).toBe("7b");
});

test("R1: no ladder → base model every attempt, winningModelId null on failure", async () => {
  const res = await runBestOfNLoop(makeOpts(2, null).opts);
  expect(modelIdsSeen).toEqual([undefined, undefined]); // makeOpts state has no modelId
  expect(res.modelsUsed).toEqual(["base", "base"]); // deps {} → profile?.id undefined → "base"
  expect(res.winningModelId).toBeNull();
});
