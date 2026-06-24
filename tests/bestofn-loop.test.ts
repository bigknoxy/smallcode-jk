import { mock, test, expect, beforeEach } from "bun:test";

// Mock the agent loop so we can drive Best-of-N control flow without a model.
// Each fake runLoop records the temperature it was handed and returns the state.
const tempsSeen: number[] = [];
mock.module("../src/agent/loop.ts", () => ({
  runLoop: async (state: any, _sp: string, deps: any) => {
    tempsSeen.push(deps.samplingOverride?.temperature);
    return state;
  },
}));

const { runBestOfNLoop, defaultTemperatures } = await import("../src/agent/bestofn-loop.ts");

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
});

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
