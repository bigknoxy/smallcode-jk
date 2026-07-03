import { describe, expect, it } from "bun:test";
import { buildTurnPrompt } from "../src/agent/prompt.ts";
import type { AgentState, TurnRecord } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { FailureDiagnostic } from "../src/verify/failure-extract.ts";

// ---------------------------------------------------------------------------
// Lever A — model-side read-after-delete HINT (SMALLCODE_RAD_HINT).
//
// When a failing turn leaves the `X.delete(K); X.set(K, X.get(K))` ordering bug
// on the locked target, the loop stashes `readAfterDelete` on the turn record.
// The next prompt must surface a "## STATEMENT ORDER BUG" section leading with
// the precomputed hint so the MODEL reorders the read. It is a pure prompt
// signal — no mutationRepair field is set — so any resulting pass stays
// attributed to the model.
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    sessionId: "s1",
    task: "Fix the LRU get ordering bug",
    repoRoot: "/tmp/repo",
    modelId: "test-model",
    goals: [{ id: "goal-1", description: "Fix get in src/cache.ts", status: "in_progress" }],
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
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 10,
    completionTokens: 20,
    timestamp: 0,
    ...overrides,
  };
}

function makeDiagnostic(overrides: Partial<FailureDiagnostic> = {}): FailureDiagnostic {
  return {
    assertionId: "get preserves the value after recency bump",
    expected: "1",
    actual: "undefined",
    message: "error: expect(received).toBe(expected)",
    errorType: "AssertionError",
    raw: "Expected: 1\nReceived: undefined",
    ...overrides,
  };
}

function makeContext(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    chunks: [],
    totalTokens: 0,
    tokenBudget: 4096,
    truncated: false,
    query: "goal",
    ...overrides,
  };
}

const RAD = {
  object: "map",
  key: "key",
  line: 7,
  hint: "`map.delete(key)` runs before `map.get(key)`, so the value read is undefined. Read the value into a variable BEFORE deleting: `const val = map.get(key); map.delete(key); map.set(key, val);`",
};

describe("buildTurnPrompt — Lever A statement-order hint", () => {
  it("renders a ## STATEMENT ORDER BUG section leading with the hint when readAfterDelete is set", () => {
    const state = makeState({
      turns: [makeTurn({ diagnostic: makeDiagnostic(), readAfterDelete: RAD })],
    });
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).toContain("## STATEMENT ORDER BUG");
    expect(prompt).toContain(RAD.hint);
    // Directive telling the model to read into a variable before deleting.
    expect(prompt).toContain("BEFORE the `delete`");
    // The section leads with the hint (hint precedes the directive).
    const hintIdx = prompt.indexOf(RAD.hint);
    const dirIdx = prompt.indexOf("BEFORE the `delete`");
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(dirIdx).toBeGreaterThan(hintIdx);
  });

  it("omits the section when readAfterDelete is not set", () => {
    const state = makeState({ turns: [makeTurn({ diagnostic: makeDiagnostic() })] });
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).not.toContain("## STATEMENT ORDER BUG");
  });

  it("suppresses the section under answerNow (no reasoning budget)", () => {
    const state = makeState({
      turns: [makeTurn({ diagnostic: makeDiagnostic(), readAfterDelete: RAD })],
    });
    const prompt = buildTurnPrompt(state, makeContext(), { answerNow: true });
    expect(prompt).not.toContain("## STATEMENT ORDER BUG");
  });
});
