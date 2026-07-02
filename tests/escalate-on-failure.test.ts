import { describe, expect, it } from "bun:test";
import { runEscalateOnFailure } from "../src/agent/escalate-on-failure.ts";
import type { AgentState } from "../src/agent/types.ts";

// Minimal AgentState stand-in — the sequencer only ever passes it through.
function fakeState(modelId: string): AgentState {
  return { modelId } as unknown as AgentState;
}

describe("runEscalateOnFailure", () => {
  it("stops at the first model that solves it (no further attempts, no reset after solve)", async () => {
    const ran: string[] = [];
    let resets = 0;
    const result = await runEscalateOnFailure({
      models: ["a", "b", "c"],
      runAttempt: async (id) => {
        ran.push(id);
        return fakeState(id);
      },
      isSolved: (s) => (s as { modelId: string }).modelId === "a",
      reset: () => {
        resets++;
      },
    });
    expect(ran).toEqual(["a"]); // never ran b or c
    expect(resets).toBe(0); // solved on first → no reset
    expect(result.solvedModelId).toBe("a");
    expect(result.attemptsUsed).toBe(1);
  });

  it("escalates through the ladder and resets between attempts, solving on the last rung", async () => {
    const ran: string[] = [];
    const resetOrder: string[] = [];
    let lastRan = "";
    const result = await runEscalateOnFailure({
      models: ["small", "mid", "big"],
      runAttempt: async (id) => {
        ran.push(id);
        lastRan = id;
        return fakeState(id);
      },
      isSolved: (s) => (s as { modelId: string }).modelId === "big",
      // reset runs BEFORE each non-first attempt → records which model just failed.
      reset: () => {
        resetOrder.push(lastRan);
      },
    });
    expect(ran).toEqual(["small", "mid", "big"]);
    // reset fired before mid (small failed) and before big (mid failed): 2 resets.
    expect(resetOrder).toEqual(["small", "mid"]);
    expect(result.solvedModelId).toBe("big");
    expect(result.attemptsUsed).toBe(3);
  });

  it("returns the LAST attempt's state (biggest model) when nothing solves it", async () => {
    const result = await runEscalateOnFailure({
      models: ["small", "big"],
      runAttempt: async (id) => fakeState(id),
      isSolved: () => false,
      reset: () => {},
    });
    expect(result.solvedModelId).toBeUndefined();
    expect(result.attemptsUsed).toBe(2);
    expect((result.finalState as { modelId: string }).modelId).toBe("big");
  });

  it("throws on an empty ladder", async () => {
    await expect(
      runEscalateOnFailure({
        models: [],
        runAttempt: async () => fakeState("x"),
        isSolved: () => true,
        reset: () => {},
      }),
    ).rejects.toThrow("non-empty");
  });

  it("a single-model ladder is a plain single-shot (no reset, one attempt)", async () => {
    let resets = 0;
    const result = await runEscalateOnFailure({
      models: ["only"],
      runAttempt: async (id) => fakeState(id),
      isSolved: () => false,
      reset: () => {
        resets++;
      },
    });
    expect(resets).toBe(0);
    expect(result.attemptsUsed).toBe(1);
    expect(result.solvedModelId).toBeUndefined();
  });
});
