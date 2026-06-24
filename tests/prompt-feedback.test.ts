import { describe, expect, it } from "bun:test";
import { buildTurnPrompt } from "../src/agent/index.ts";
import type { AgentConfig, AgentState, TurnRecord } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { FailureDiagnostic } from "../src/verify/failure-extract.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    repoRoot: "/tmp/test",
    modelId: "test-model",
    maxTurns: 10,
    bestOfN: 1,
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  const config = makeConfig({ repoRoot: overrides.repoRoot ?? "/tmp/test" });
  return {
    sessionId: "test-session",
    task: "implement add(a, b)",
    repoRoot: config.repoRoot,
    modelId: config.modelId,
    goals: [{ id: "goal-1", description: "write the add function", status: "in_progress" }],
    currentGoalIndex: 0,
    turns: [],
    status: "running",
    scratchpad: "",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    maxTurns: 10,
    ...overrides,
  };
}

function makeContext(): ContextBundle {
  return {
    chunks: [],
    totalTokens: 0,
    tokenBudget: 2048,
    truncated: false,
    query: "goal",
  };
}

function makeDiagnostic(overrides: Partial<FailureDiagnostic> = {}): FailureDiagnostic {
  return {
    assertionId: "add > returns correct sum",
    expected: "5",
    actual: "3",
    message: "error: expect(received).toBe(expected)",
    errorType: "AssertionError",
    raw: "Expected: 5\nReceived: 3\n(fail) add > returns correct sum [0.10ms]",
    ...overrides,
  };
}

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turn: 1,
    goalId: "goal-1",
    prompt: "test prompt",
    rawResponse: "raw",
    answer: "answer",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 10,
    completionTokens: 20,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildTurnPrompt — default behavior (no opts)
// ---------------------------------------------------------------------------

describe("buildTurnPrompt — default (no opts)", () => {
  it("contains task and goal description", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, makeContext());

    expect(prompt).toContain("implement add(a, b)");
    expect(prompt).toContain("write the add function");
  });

  it("does NOT emit REDRAFT section by default", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).not.toContain("REDRAFT");
  });

  it("includes Recent History when turns exist (no opts)", () => {
    const state = makeState();
    state.turns = [makeTurn({ turn: 1 })];
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).toContain("Recent History");
  });
});

// ---------------------------------------------------------------------------
// buildTurnPrompt — with stored diagnostic on last turn
// ---------------------------------------------------------------------------

describe("buildTurnPrompt — stored diagnostic renders Expected/Received", () => {
  it("emits Failure (fix THIS) header when last turn has diagnostic", () => {
    const state = makeState();
    state.turns = [
      makeTurn({
        turn: 1,
        diagnostic: makeDiagnostic(),
      }),
    ];
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).toContain("**Failure (fix THIS):**");
  });

  it("renders Expected value in prompt", () => {
    const state = makeState();
    state.turns = [makeTurn({ turn: 1, diagnostic: makeDiagnostic({ expected: "5", actual: "3" }) })];
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).toContain("Expected: 5");
  });

  it("renders Received value in prompt", () => {
    const state = makeState();
    state.turns = [makeTurn({ turn: 1, diagnostic: makeDiagnostic({ expected: "5", actual: "3" }) })];
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).toContain("Received: 3");
  });

  it("does NOT emit Failure header when last turn has no diagnostic", () => {
    const state = makeState();
    state.turns = [makeTurn({ turn: 1 })]; // no diagnostic
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).not.toContain("**Failure (fix THIS):**");
  });

  it("does NOT emit Failure header when there are no turns", () => {
    const state = makeState(); // no turns
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).not.toContain("**Failure (fix THIS):**");
  });
});

// ---------------------------------------------------------------------------
// buildTurnPrompt — {redraft: true}
// ---------------------------------------------------------------------------

describe("buildTurnPrompt — {redraft: true}", () => {
  it("emits REDRAFT section", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, makeContext(), { redraft: true });
    expect(prompt).toContain("REDRAFT");
  });

  it("REDRAFT section mentions 'previous approach is stuck'", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, makeContext(), { redraft: true });
    expect(prompt).toContain("previous approach is stuck");
  });

  it("suppresses Recent History block on redraft", () => {
    const state = makeState();
    state.turns = [makeTurn({ turn: 1 }), makeTurn({ turn: 2 })];
    const prompt = buildTurnPrompt(state, makeContext(), { redraft: true });
    expect(prompt).not.toContain("Recent History");
  });

  it("still shows task on redraft", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, makeContext(), { redraft: true });
    expect(prompt).toContain("implement add(a, b)");
  });

  it("still shows goal/action on redraft", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, makeContext(), { redraft: true });
    expect(prompt).toContain("write the add function");
  });

  it("includes strategyHint when provided", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, makeContext(), {
      redraft: true,
      strategyHint: "handle edge cases first",
    });
    expect(prompt).toContain("handle edge cases first");
  });

  it("does NOT include strategyHint section when hint is absent", () => {
    const state = makeState();
    const prompt = buildTurnPrompt(state, makeContext(), { redraft: true });
    expect(prompt).not.toContain("Strategy hint:");
  });

  it("still renders failure diagnostic on redraft when last turn has one", () => {
    const state = makeState();
    state.turns = [makeTurn({ turn: 1, diagnostic: makeDiagnostic({ expected: "99", actual: "1" }) })];
    const prompt = buildTurnPrompt(state, makeContext(), { redraft: true });
    expect(prompt).toContain("**Failure (fix THIS):**");
    expect(prompt).toContain("Expected: 99");
  });
});
