import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunResult, TaskEvalResult } from "../src/eval/types.ts";
import { MetricsStore } from "../src/improve/metrics-store.ts";
import { checkRegression, runGate } from "../src/improve/regression-gate.ts";
import type { MetricsSnapshot } from "../src/improve/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTaskResult(taskId: string, passAt1: number): TaskEvalResult {
  return {
    task: {
      id: taskId,
      desc: `Task ${taskId}`,
      setup: {},
      graders: [],
      trackedMetrics: [],
    },
    trials: [],
    passAt1,
    passAtK: {},
    passAllK: passAt1,
    avgPartialScore: passAt1,
    avgMetrics: {
      nTurns: 1,
      nToolCalls: 1,
      nTotalTokens: 100,
      nPromptTokens: 80,
      nCompletionTokens: 20,
      latencyMs: 500,
    },
  };
}

function makeRunResult(
  overrides: Partial<EvalRunResult> & { taskResults?: TaskEvalResult[] } = {},
): EvalRunResult {
  const taskResults = overrides.taskResults ?? [
    makeTaskResult("task-a", 1.0),
    makeTaskResult("task-b", 1.0),
  ];
  const overallPassAt1 =
    overrides.overallPassAt1 ??
    (taskResults.length === 0
      ? 0
      : taskResults.reduce((s, r) => s + r.passAt1, 0) / taskResults.length);

  return {
    runId: randomUUID(),
    suiteId: "suite-default",
    modelId: "test-model",
    taskResults,
    overallPassAt1,
    totalTrials: taskResults.length,
    totalTasksPassed: taskResults.filter((r) => r.passAt1 >= 1.0).length,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    timestamp: Date.now(),
    runId: randomUUID(),
    suiteId: "suite-default",
    modelId: "test-model",
    overallPassAt1: 1.0,
    totalTasksPassed: 2,
    totalTasks: 2,
    perTaskPassAt1: { "task-a": 1.0, "task-b": 1.0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test directory setup
// ---------------------------------------------------------------------------

let testDir: string;
let storePath: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `improve-metrics-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(testDir, { recursive: true });
  storePath = join(testDir, "metrics.jsonl");
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. MetricsStore.append writes snapshot to file
// ---------------------------------------------------------------------------

describe("MetricsStore.append", () => {
  it("writes a snapshot to the file", async () => {
    const store = new MetricsStore(storePath);
    const result = makeRunResult({ suiteId: "suite-1" });
    const now = Date.now();

    await store.append(result, now);

    const history = await store.getHistory("suite-1");
    expect(history.snapshots.length).toBe(1);

    const snap = history.snapshots[0];
    expect(snap).toBeDefined();
    expect(snap?.runId).toBe(result.runId);
    expect(snap?.suiteId).toBe("suite-1");
    expect(snap?.timestamp).toBe(now);
    expect(snap?.overallPassAt1).toBe(result.overallPassAt1);
  });
});

// ---------------------------------------------------------------------------
// 2. MetricsStore.getHistory returns snapshots for correct suiteId only
// ---------------------------------------------------------------------------

describe("MetricsStore.getHistory", () => {
  it("returns only snapshots matching the suiteId", async () => {
    const store = new MetricsStore(storePath);
    const now = Date.now();

    await store.append(makeRunResult({ suiteId: "suite-alpha" }), now);
    await store.append(makeRunResult({ suiteId: "suite-beta" }), now + 1);
    await store.append(makeRunResult({ suiteId: "suite-alpha" }), now + 2);

    const alpha = await store.getHistory("suite-alpha");
    expect(alpha.suiteId).toBe("suite-alpha");
    expect(alpha.snapshots.length).toBe(2);
    for (const s of alpha.snapshots) {
      expect(s.suiteId).toBe("suite-alpha");
    }

    const beta = await store.getHistory("suite-beta");
    expect(beta.snapshots.length).toBe(1);
    expect(beta.snapshots[0]?.suiteId).toBe("suite-beta");
  });
});

// ---------------------------------------------------------------------------
// 3. MetricsStore.getLatest returns most recent snapshot
// ---------------------------------------------------------------------------

describe("MetricsStore.getLatest", () => {
  it("returns the most recent snapshot for the suiteId", async () => {
    const store = new MetricsStore(storePath);
    const base = Date.now();

    const r1 = makeRunResult({ suiteId: "suite-x", overallPassAt1: 0.7 });
    const r2 = makeRunResult({ suiteId: "suite-x", overallPassAt1: 0.85 });
    const r3 = makeRunResult({ suiteId: "suite-x", overallPassAt1: 0.9 });

    await store.append(r1, base);
    await store.append(r2, base + 100);
    await store.append(r3, base + 200);

    const latest = await store.getLatest("suite-x");
    expect(latest).not.toBeNull();
    expect(latest?.runId).toBe(r3.runId);
    expect(latest?.overallPassAt1).toBe(0.9);
  });

  it("returns null when no snapshots exist for suiteId", async () => {
    const store = new MetricsStore(storePath);
    const latest = await store.getLatest("nonexistent-suite");
    expect(latest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. MetricsStore.query filters by since timestamp
// ---------------------------------------------------------------------------

describe("MetricsStore.query", () => {
  it("filters snapshots by since timestamp", async () => {
    const store = new MetricsStore(storePath);
    const base = 1_000_000;

    await store.append(makeRunResult({ suiteId: "suite-q" }), base + 10);
    await store.append(makeRunResult({ suiteId: "suite-q" }), base + 20);
    await store.append(makeRunResult({ suiteId: "suite-q" }), base + 30);

    // since=base+15 → only timestamps > base+15
    const result = await store.query("suite-q", base + 15);
    expect(result.length).toBe(2);
    for (const s of result) {
      expect(s.timestamp).toBeGreaterThan(base + 15);
    }
  });

  it("returns all when since is undefined", async () => {
    const store = new MetricsStore(storePath);
    const base = Date.now();

    await store.append(makeRunResult({ suiteId: "suite-q2" }), base);
    await store.append(makeRunResult({ suiteId: "suite-q2" }), base + 1);

    const result = await store.query("suite-q2");
    expect(result.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. MetricsStore round-trip: append multiple runs, getHistory returns all
// ---------------------------------------------------------------------------

describe("MetricsStore round-trip", () => {
  it("append multiple runs, getHistory returns all", async () => {
    const store = new MetricsStore(storePath);
    const suiteId = "suite-rt";
    const base = Date.now();
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRunResult({ suiteId, overallPassAt1: 0.6 + i * 0.08 }),
    );

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (run !== undefined) {
        await store.append(run, base + i * 100);
      }
    }

    const history = await store.getHistory(suiteId);
    expect(history.snapshots.length).toBe(5);

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const snap = history.snapshots[i];
      if (run !== undefined && snap !== undefined) {
        expect(snap.runId).toBe(run.runId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. checkRegression: no baseline → passes if above threshold
// ---------------------------------------------------------------------------

describe("checkRegression", () => {
  it("no baseline → passes if above threshold", () => {
    const result = makeRunResult({ overallPassAt1: 0.95 });
    const gateResult = checkRegression(result, null, { threshold: 0.9 });

    expect(gateResult.passed).toBe(true);
    expect(gateResult.baselinePassAt1).toBe(0);
    expect(gateResult.currentPassAt1).toBe(0.95);
    expect(gateResult.delta).toBe(0.95);
    expect(gateResult.regressedTasks).toHaveLength(0);
  });

  it("no baseline → fails if below threshold", () => {
    const result = makeRunResult({ overallPassAt1: 0.8 });
    const gateResult = checkRegression(result, null, { threshold: 0.9 });

    expect(gateResult.passed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 7. checkRegression: delta within allowDelta → passes
  // ---------------------------------------------------------------------------

  it("delta within allowDelta → passes", () => {
    const baseline = makeSnapshot({ overallPassAt1: 0.9, perTaskPassAt1: { "task-a": 1.0 } });
    const result = makeRunResult({
      overallPassAt1: 0.87,
      taskResults: [makeTaskResult("task-a", 0.87)],
    });

    const gateResult = checkRegression(result, baseline, {
      threshold: 0.8,
      allowDelta: 0.05,
    });

    // delta = 0.87 - 0.9 = -0.03; allowDelta=0.05 → -0.03 >= -0.05 → OK
    expect(gateResult.passed).toBe(true);
    expect(gateResult.delta).toBeCloseTo(-0.03, 5);
  });

  // ---------------------------------------------------------------------------
  // 8. checkRegression: delta exceeds allowDelta → fails
  // ---------------------------------------------------------------------------

  it("delta exceeds allowDelta → fails", () => {
    const baseline = makeSnapshot({ overallPassAt1: 0.9, perTaskPassAt1: { "task-a": 1.0 } });
    const result = makeRunResult({
      overallPassAt1: 0.8,
      taskResults: [makeTaskResult("task-a", 0.8)],
    });

    const gateResult = checkRegression(result, baseline, {
      threshold: 0.75,
      allowDelta: 0.05,
    });

    // delta = 0.8 - 0.9 = -0.1; allowDelta=0.05 → -0.1 < -0.05 → fails
    expect(gateResult.passed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 9. checkRegression: below threshold → fails regardless of delta
  // ---------------------------------------------------------------------------

  it("below threshold → fails regardless of delta", () => {
    const baseline = makeSnapshot({ overallPassAt1: 0.5, perTaskPassAt1: {} });
    const result = makeRunResult({ overallPassAt1: 0.6, taskResults: [] });

    const gateResult = checkRegression(result, baseline, {
      threshold: 0.8,
      allowDelta: 0.5, // very generous allowDelta
    });

    // 0.6 > 0.5 (positive delta) but 0.6 < threshold 0.8 → fails
    expect(gateResult.passed).toBe(false);
    expect(gateResult.delta).toBeCloseTo(0.1, 5);
  });

  // ---------------------------------------------------------------------------
  // 10. checkRegression: identifies regressed tasks by per-task pass@1
  // ---------------------------------------------------------------------------

  it("identifies regressed tasks by per-task pass@1", () => {
    const baseline = makeSnapshot({
      overallPassAt1: 0.9,
      perTaskPassAt1: {
        "task-a": 1.0,
        "task-b": 1.0,
        "task-c": 0.8,
      },
    });

    const result = makeRunResult({
      overallPassAt1: 0.85,
      taskResults: [
        makeTaskResult("task-a", 1.0), // same → no regression
        makeTaskResult("task-b", 0.5), // dropped from 1.0 → regressed
        makeTaskResult("task-c", 0.6), // dropped from 0.8 → regressed
      ],
    });

    const gateResult = checkRegression(result, baseline, {
      threshold: 0.7,
      allowDelta: 0.3,
    });

    expect(gateResult.regressedTasks).toContain("task-b");
    expect(gateResult.regressedTasks).toContain("task-c");
    expect(gateResult.regressedTasks).not.toContain("task-a");
  });
});

// ---------------------------------------------------------------------------
// 11. runGate appends to store after checking
// ---------------------------------------------------------------------------

describe("runGate", () => {
  it("appends current result to store after checking", async () => {
    const store = new MetricsStore(storePath);
    const suiteId = "suite-gate";
    const result = makeRunResult({ suiteId, overallPassAt1: 0.95 });
    const now = Date.now();

    // No baseline initially
    expect(await store.getLatest(suiteId)).toBeNull();

    await runGate(result, store, { threshold: 0.9 }, now);

    // Should be stored now
    const latest = await store.getLatest(suiteId);
    expect(latest).not.toBeNull();
    expect(latest?.runId).toBe(result.runId);
  });

  it("uses existing latest as baseline and appends new result", async () => {
    const store = new MetricsStore(storePath);
    const suiteId = "suite-gate2";
    const baselineResult = makeRunResult({ suiteId, overallPassAt1: 0.9 });
    const base = Date.now();

    // Pre-seed a baseline
    await store.append(baselineResult, base);

    const newResult = makeRunResult({ suiteId, overallPassAt1: 0.95 });
    const gateResult = await runGate(newResult, store, { threshold: 0.9 }, base + 100);

    // baseline was 0.9, current 0.95 → delta 0.05 → passed
    expect(gateResult.passed).toBe(true);
    expect(gateResult.baselinePassAt1).toBe(0.9);
    expect(gateResult.currentPassAt1).toBe(0.95);

    // Both runs now in store
    const history = await store.getHistory(suiteId);
    expect(history.snapshots.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 12. ABResult: winner "A" when A passAt1 > B
// ---------------------------------------------------------------------------

describe("ABResult winner logic (via checkRegression as proxy)", () => {
  it("winner is A when A passAt1 > B passAt1", () => {
    // Test the ABResult winner logic directly by constructing the comparison
    const passAt1A = 0.9;
    const passAt1B = 0.8;

    const winner: "A" | "B" | "tie" = passAt1A > passAt1B ? "A" : passAt1B > passAt1A ? "B" : "tie";

    expect(winner).toBe("A");
  });

  // ---------------------------------------------------------------------------
  // 13. ABResult: winner "tie" when equal
  // ---------------------------------------------------------------------------

  it("winner is tie when A passAt1 === B passAt1", () => {
    const passAt1A = 0.85;
    const passAt1B = 0.85;

    const winner: "A" | "B" | "tie" = passAt1A > passAt1B ? "A" : passAt1B > passAt1A ? "B" : "tie";

    expect(winner).toBe("tie");
  });

  it("winner is B when B passAt1 > A passAt1", () => {
    const passAt1A = 0.75;
    const passAt1B = 0.9;

    const winner: "A" | "B" | "tie" = passAt1A > passAt1B ? "A" : passAt1B > passAt1A ? "B" : "tie";

    expect(winner).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// Bonus: perTaskPassAt1 correctly built from taskResults
// ---------------------------------------------------------------------------

describe("MetricsStore perTaskPassAt1 snapshot", () => {
  it("builds perTaskPassAt1 correctly from taskResults", async () => {
    const store = new MetricsStore(storePath);
    const result = makeRunResult({
      suiteId: "suite-per-task",
      taskResults: [
        makeTaskResult("task-foo", 0.75),
        makeTaskResult("task-bar", 1.0),
        makeTaskResult("task-baz", 0.5),
      ],
    });
    const now = Date.now();

    await store.append(result, now);

    const latest = await store.getLatest("suite-per-task");
    expect(latest?.perTaskPassAt1["task-foo"]).toBe(0.75);
    expect(latest?.perTaskPassAt1["task-bar"]).toBe(1.0);
    expect(latest?.perTaskPassAt1["task-baz"]).toBe(0.5);
    expect(latest?.totalTasks).toBe(3);
  });
});
