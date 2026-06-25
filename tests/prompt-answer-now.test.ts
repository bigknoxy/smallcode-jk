import { describe, expect, it } from "bun:test";
import { buildTurnPrompt } from "../src/agent/prompt.ts";
import type { AgentState, TurnRecord } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    sessionId: "s1",
    task: "Fix the parser",
    repoRoot: "/tmp/repo",
    modelId: "test-model",
    goals: [
      { id: "goal-1", description: "Patch parseConfig in src/config.ts", status: "in_progress" },
    ],
    currentGoalIndex: 0,
    turns: [],
    status: "running",
    scratchpad: "",
    startedAt: 0,
    updatedAt: 0,
    maxTurns: 10,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turn: 1,
    goalId: "goal-1",
    prompt: "p",
    rawResponse: "r",
    answer: "a",
    toolCalls: [],
    toolResults: [{ name: "run_tests", success: false, output: "FAIL: expected 3 got 5" }],
    editBlocks: [],
    applyResults: [],
    promptTokens: 10,
    completionTokens: 20,
    timestamp: 0,
    ...overrides,
  };
}

const emptyContext: ContextBundle = {
  chunks: [],
  totalTokens: 0,
  tokenBudget: 2048,
  truncated: false,
  query: "goal",
};

// ---------------------------------------------------------------------------
// answerNow prompt
// ---------------------------------------------------------------------------

describe("buildTurnPrompt answerNow", () => {
  it("emits an ANSWER NOW section telling the model to skip thinking and act", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, emptyContext, { answerNow: true });

    expect(prompt).toContain("ANSWER NOW");
    // It must steer away from reasoning and toward immediate action.
    expect(prompt).toContain("Do NOT think");
    expect(prompt).toMatch(/FILE: block or TOOL: call/);
  });

  it("suppresses Recent History on answer-now (less to read = less to re-think)", () => {
    const state = makeState({ turns: [makeTurn()] });
    const prompt = buildTurnPrompt(state, emptyContext, { answerNow: true });

    expect(prompt).not.toContain("## Recent History");
    expect(prompt).not.toContain("FAIL: expected 3 got 5");
  });

  it("still includes the task and current goal so the model knows what to do", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, emptyContext, { answerNow: true });

    expect(prompt).toContain("Fix the parser");
    expect(prompt).toContain("Patch parseConfig in src/config.ts");
  });

  it("takes precedence over redraft when both are set (any answer beats a new approach)", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, emptyContext, {
      answerNow: true,
      redraft: true,
      strategyHint: "use a set/dedup explicitly",
    });

    expect(prompt).toContain("ANSWER NOW");
    expect(prompt).not.toContain("REDRAFT");
    expect(prompt).not.toContain("use a set/dedup explicitly");
  });

  it("normal turn (no opts) is unchanged — no ANSWER NOW leakage", () => {
    const state = makeState({ turns: [makeTurn()] });
    const prompt = buildTurnPrompt(state, emptyContext);

    expect(prompt).not.toContain("ANSWER NOW");
    expect(prompt).toContain("## Recent History");
  });
});
