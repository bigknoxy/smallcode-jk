import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TurnRecord } from "../src/agent/types.ts";
import type { EvalRunResult, EvalTask, Transcript, TrialResult } from "../src/eval/types.ts";
import { renderEvalRunResult, renderTranscript, renderTrialResult } from "../src/eval/viewer.ts";

// ---------------------------------------------------------------------------
// Minimal fixture factories
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turn: 1,
    goalId: "goal-1",
    prompt: "do something",
    rawResponse: "raw",
    reasoning: undefined,
    answer: "I did it.",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 100,
    completionTokens: 50,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeTranscript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    id: "tx-001",
    sessionId: "sess-001",
    taskId: "task-abc",
    trialIndex: 0,
    modelId: "test-model",
    turns: [],
    outcome: "passed",
    startedAt: 1000,
    finishedAt: 9000,
    ...overrides,
  };
}

function makeTaskStub(id: string): EvalTask {
  return {
    id,
    desc: `Task ${id}`,
    setup: {},
    graders: [],
    trackedMetrics: ["n_turns", "pass_at_1"],
  };
}

function makeTrialResult(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    taskId: "task-abc",
    trialIndex: 0,
    passed: true,
    partialScore: 1.0,
    graderResults: [],
    transcript: makeTranscript(),
    metrics: {
      nTurns: 3,
      nToolCalls: 5,
      nTotalTokens: 1240,
      nPromptTokens: 800,
      nCompletionTokens: 440,
      latencyMs: 8200,
    },
    ...overrides,
  };
}

function makeEvalRunResult(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    runId: "run-001",
    suiteId: "regression-v1",
    modelId: "test-model",
    taskResults: [],
    overallPassAt1: 0,
    totalTrials: 0,
    totalTasksPassed: 0,
    startedAt: 1000,
    finishedAt: 61000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderTranscript tests
// ---------------------------------------------------------------------------

describe("renderTranscript", () => {
  test("0 turns: still renders header", () => {
    const t = makeTranscript({ turns: [] });
    const out = renderTranscript(t);
    expect(out).toContain("=== Transcript: tx-001 ===");
    expect(out).toContain("Task: task-abc");
    expect(out).toContain("Model: test-model");
    expect(out).toContain("Outcome: passed");
  });

  test("1 turn: contains turn section", () => {
    const turn = makeTurn({ turn: 1, goalId: "goal-1", answer: "My answer here." });
    const t = makeTranscript({ turns: [turn] });
    const out = renderTranscript(t);
    expect(out).toContain("--- Turn 1 / Goal: goal-1 ---");
    expect(out).toContain("My answer here.");
  });

  test("reasoning: shows [REASONING] prefix, truncated at 200 chars", () => {
    const longReasoning = "A".repeat(300);
    const turn = makeTurn({ reasoning: longReasoning, answer: "Done." });
    const t = makeTranscript({ turns: [turn] });
    const out = renderTranscript(t);
    expect(out).toContain("[REASONING]");
    // Should be truncated — full 300 chars should not appear
    expect(out).not.toContain("A".repeat(201));
  });
});

// ---------------------------------------------------------------------------
// renderTrialResult tests
// ---------------------------------------------------------------------------

describe("renderTrialResult", () => {
  test("passed=true shows YES", () => {
    const result = makeTrialResult({ passed: true });
    const out = renderTrialResult(result);
    expect(out).toContain("Passed: YES");
  });

  test("passed=false shows NO", () => {
    const result = makeTrialResult({ passed: false, partialScore: 0.0 });
    const out = renderTrialResult(result);
    expect(out).toContain("Passed: NO");
  });

  test("includes metrics line", () => {
    const result = makeTrialResult();
    const out = renderTrialResult(result);
    expect(out).toContain("Metrics:");
    expect(out).toContain("turns=3");
    expect(out).toContain("tokens=1240");
  });

  test("grader results appear in output", () => {
    const result = makeTrialResult({
      graderResults: [
        {
          type: "static_analysis",
          verdict: "fail",
          score: 0.0,
          output: "tsc: 2 errors",
          durationMs: 350,
        },
      ],
    });
    const out = renderTrialResult(result);
    expect(out).toContain("static_analysis");
    expect(out).toContain("FAIL");
  });
});

// ---------------------------------------------------------------------------
// renderEvalRunResult tests
// ---------------------------------------------------------------------------

describe("renderEvalRunResult", () => {
  function makeTwoTaskRun(): EvalRunResult {
    return makeEvalRunResult({
      taskResults: [
        {
          task: makeTaskStub("fix-null-deref_1"),
          trials: [makeTrialResult({ passed: true, taskId: "fix-null-deref_1" })],
          passAt1: 1.0,
          passAtK: { 1: 1.0 },
          passAllK: 1.0,
          avgPartialScore: 1.0,
          avgMetrics: makeTrialResult().metrics,
        },
        {
          task: makeTaskStub("add-missing-import_1"),
          trials: [
            makeTrialResult({ passed: false, taskId: "add-missing-import_1", partialScore: 0 }),
          ],
          passAt1: 0.0,
          passAtK: { 1: 0.0 },
          passAllK: 0.0,
          avgPartialScore: 0.0,
          avgMetrics: makeTrialResult().metrics,
        },
      ],
      overallPassAt1: 0.5,
      totalTrials: 2,
      totalTasksPassed: 1,
    });
  }

  test("table shows both task IDs", () => {
    const result = makeTwoTaskRun();
    const out = renderEvalRunResult(result);
    expect(out).toContain("fix-null-deref_1");
    expect(out).toContain("add-missing-import_1");
  });

  test("overall pass@1 fraction is correct", () => {
    const result = makeTwoTaskRun();
    const out = renderEvalRunResult(result);
    // 1/2 tasks = 0.50
    expect(out).toContain("0.50");
    expect(out).toContain("1/2");
  });

  test("header shows runId and suiteId", () => {
    const result = makeTwoTaskRun();
    const out = renderEvalRunResult(result);
    expect(out).toContain("=== Eval Run: run-001 ===");
    expect(out).toContain("Suite: regression-v1");
  });
});

// ---------------------------------------------------------------------------
// Seed task validation
// ---------------------------------------------------------------------------

const REGRESSION_DIR = resolve(import.meta.dir, "../evals/suites/regression");

describe("seed tasks", () => {
  test("all JSON files in regression dir parse without error", async () => {
    const entries = await readdir(REGRESSION_DIR);
    const taskFiles = entries.filter((e) => e.endsWith(".json") && e !== "suite.json");

    expect(taskFiles.length).toBeGreaterThanOrEqual(20);

    for (const file of taskFiles) {
      const content = await readFile(join(REGRESSION_DIR, file), "utf-8");
      expect(() => JSON.parse(content), `${file} should be valid JSON`).not.toThrow();
    }
  });

  test("each seed task has required fields: id, desc, setup, graders, tracked_metrics", async () => {
    const entries = await readdir(REGRESSION_DIR);
    const taskFiles = entries.filter((e) => e.endsWith(".json") && e !== "suite.json");

    for (const file of taskFiles) {
      const content = await readFile(join(REGRESSION_DIR, file), "utf-8");
      const task = JSON.parse(content) as Record<string, unknown>;

      expect(task, `${file}`).toHaveProperty("id");
      expect(task, `${file}`).toHaveProperty("desc");
      expect(task, `${file}`).toHaveProperty("setup");
      expect(task, `${file}`).toHaveProperty("graders");
      expect(
        task["tracked_metrics"] !== undefined || task["trackedMetrics"] !== undefined,
        `${file} must have tracked_metrics or trackedMetrics`,
      ).toBe(true);
    }
  });

  test("suite.json has kind='regression'", async () => {
    const content = await readFile(join(REGRESSION_DIR, "suite.json"), "utf-8");
    const suite = JSON.parse(content) as Record<string, unknown>;
    expect(suite["kind"]).toBe("regression");
  });
});
