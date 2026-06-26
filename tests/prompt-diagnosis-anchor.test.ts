import { describe, expect, it } from "bun:test";
import { buildTurnPrompt } from "../src/agent/prompt.ts";
import type { AgentState, TurnRecord } from "../src/agent/types.ts";
import type { ContextBundle, TargetFile } from "../src/context/types.ts";
import type { FailureDiagnostic } from "../src/verify/failure-extract.ts";

// ---------------------------------------------------------------------------
// FRONT: bug-diagnosis aid + promote minimal-diff PATCH default ON.
//
// PROBLEM A (mri-flags 0/10): qwen emits a mechanically-valid SEARCH/REPLACE
//   diff but edits the WRONG line — it cannot LOCATE a subtle operator bug deep
//   in a dense ternary. The failing test's expected/received pair is the single
//   strongest localization signal. These tests pin that the diagnostic is
//   rendered ABOVE the "## Edit Target" mechanical directive (WHAT-to-fix before
//   HOW-to-emit) AND above Recent History, and that it LEADS with a stark
//   one-line mismatch anchor before any prose.
//
// PROBLEM B: SMALLCODE_DIFF_EDIT is a confirmed net win, now DEFAULT ON. These
//   tests re-pin that the minimal-diff directive fires by default for a LARGE
//   target function and does NOT alter small FILE-mode behaviour.
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    sessionId: "s1",
    task: "Fix the boolean flag operator in toVal",
    repoRoot: "/tmp/repo",
    modelId: "test-model",
    goals: [{ id: "goal-1", description: "Fix toVal in src/index.js", status: "in_progress" }],
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
    assertionId: "mri > parses negated boolean flag",
    expected: "{ no: true }",
    actual: "{ no: false }",
    message: "error: expect(received).toEqual(expected)",
    errorType: "AssertionError",
    raw: "Expected: { no: true }\nReceived: { no: false }\n(fail) mri > parses negated boolean flag [0.10ms]",
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

function makeLargeTarget(overrides: Partial<TargetFile> = {}): TargetFile {
  return {
    path: "src/index.js",
    lineCount: 220,
    format: "patch",
    functionName: "toVal",
    functionLineCount: 48, // >= DIFF_MIN_FN default 30
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PROBLEM A — localization anchor prominence
// ---------------------------------------------------------------------------

describe("buildTurnPrompt — diagnostic leads as the localization anchor (Problem A)", () => {
  it("leads the FAILING TEST block with a stark one-line expected-vs-received mismatch", () => {
    const state = makeState({ turns: [makeTurn({ diagnostic: makeDiagnostic() })] });
    const prompt = buildTurnPrompt(state, makeContext());
    // Stark one-liner anchor, distinct from renderDiagnostic's two-line pair.
    expect(prompt).toContain("The test wants `{ no: true }` but the code produces `{ no: false }`.");
    // The one-liner appears BEFORE the framing prose.
    const anchorIdx = prompt.indexOf("The test wants `{ no: true }`");
    const proseIdx = prompt.indexOf("single line whose value produces");
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(proseIdx).toBeGreaterThan(anchorIdx);
  });

  it("renders the diagnostic ABOVE the ## Edit Target directive (WHAT before HOW)", () => {
    const state = makeState({ turns: [makeTurn({ diagnostic: makeDiagnostic() })] });
    const prompt = buildTurnPrompt(state, makeContext({ targetFile: makeLargeTarget() }));
    const diagIdx = prompt.indexOf("## FAILING TEST — fix exactly this");
    const editTargetIdx = prompt.indexOf("## Edit Target — src/index.js");
    expect(diagIdx).toBeGreaterThanOrEqual(0);
    expect(editTargetIdx).toBeGreaterThanOrEqual(0);
    expect(diagIdx).toBeLessThan(editTargetIdx);
  });

  it("still renders the diagnostic ABOVE Recent History", () => {
    const prevTurn = makeTurn({
      turn: 1,
      diagnostic: makeDiagnostic(),
      toolResults: [{ name: "run_tests", success: false, output: "x".repeat(600) }],
    });
    const state = makeState({ turns: [prevTurn] });
    const prompt = buildTurnPrompt(state, makeContext());
    const diagIdx = prompt.indexOf("## FAILING TEST — fix exactly this");
    const historyIdx = prompt.indexOf("## Recent History");
    expect(diagIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(diagIdx).toBeLessThan(historyIdx);
  });

  it("preserves the structured Expected/Received pair (renderDiagnostic) for detail", () => {
    const state = makeState({ turns: [makeTurn({ diagnostic: makeDiagnostic() })] });
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).toContain("Expected: { no: true }");
    expect(prompt).toContain("Received: { no: false }");
  });

  it("emits a sane anchor when one side of the mismatch is absent", () => {
    const state = makeState({
      turns: [makeTurn({ diagnostic: makeDiagnostic({ expected: "42", actual: undefined }) })],
    });
    const prompt = buildTurnPrompt(state, makeContext());
    expect(prompt).toContain("The test wants `42` but the code produces `(no value)`.");
  });

  it("suppresses the diagnostic under answerNow (no budget to re-reason)", () => {
    const state = makeState({ turns: [makeTurn({ diagnostic: makeDiagnostic() })] });
    const prompt = buildTurnPrompt(state, makeContext(), { answerNow: true });
    expect(prompt).not.toContain("## FAILING TEST — fix exactly this");
    expect(prompt).not.toContain("The test wants `{ no: true }`");
  });

  it("renders the FAILING TEST header exactly once", () => {
    const state = makeState({ turns: [makeTurn({ diagnostic: makeDiagnostic() })] });
    const prompt = buildTurnPrompt(state, makeContext({ targetFile: makeLargeTarget() }));
    expect(prompt.split("## FAILING TEST — fix exactly this").length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PROBLEM B — minimal-diff directive defaults ON (re-pin after restructure)
// ---------------------------------------------------------------------------

describe("buildTurnPrompt — minimal-diff defaults ON, unaffected by diagnostic move (Problem B)", () => {
  it("emits the SEARCH/REPLACE directive by default for a LARGE target function", () => {
    const prompt = buildTurnPrompt(makeState(), makeContext({ targetFile: makeLargeTarget() }));
    expect(prompt).toContain("<<<<<<< SEARCH");
    expect(prompt).toContain(">>>>>>> REPLACE");
    expect(prompt).toContain("MINIMAL edit");
  });

  it("does NOT switch a small FILE-mode target into diff mode", () => {
    const smallFull: TargetFile = { path: "src/math.ts", lineCount: 12, format: "full" };
    const prompt = buildTurnPrompt(makeState(), makeContext({ targetFile: smallFull }));
    expect(prompt).not.toContain("<<<<<<< SEARCH");
    expect(prompt).toContain("Emit the COMPLETE file");
  });

  it("co-renders the diagnostic anchor AND the diff directive in the right order", () => {
    const state = makeState({ turns: [makeTurn({ diagnostic: makeDiagnostic() })] });
    const prompt = buildTurnPrompt(state, makeContext({ targetFile: makeLargeTarget() }));
    // Anchor (WHAT) precedes the SEARCH/REPLACE template (HOW).
    const anchorIdx = prompt.indexOf("The test wants `{ no: true }`");
    const srIdx = prompt.indexOf("<<<<<<< SEARCH");
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(srIdx).toBeGreaterThan(anchorIdx);
  });
});
