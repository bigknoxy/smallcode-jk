import { describe, expect, it } from "bun:test";
import { fingerprintDiff } from "../src/improve/fingerprint.ts";
import type { MetricsSnapshot, TaskBehavior } from "../src/improve/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function behavior(overrides: Partial<TaskBehavior> = {}): TaskBehavior {
  return {
    passAt1: 0.7,
    avgTurns: 3,
    avgTokens: 2000,
    repairRate: 0.1,
    thinkOnlyRate: 0.1,
    ...overrides,
  };
}

function makeSnapshot(
  perTaskBehavior: Record<string, TaskBehavior>,
  perTaskCI?: MetricsSnapshot["perTaskCI"],
): MetricsSnapshot {
  return {
    timestamp: Date.now(),
    runId: "live-test",
    suiteId: "suite-test",
    modelId: "test-model",
    overallPassAt1: 0.7,
    totalTasksPassed: 1,
    totalTasks: 1,
    perTaskPassAt1: Object.fromEntries(Object.entries(perTaskBehavior).map(([k, v]) => [k, v.passAt1])),
    perTaskBehavior,
    ...(perTaskCI ? { perTaskCI } : {}),
  };
}

describe("fingerprintDiff", () => {
  it("1. identical behavior → all stable", () => {
    const base = makeSnapshot({ taskA: behavior(), taskB: behavior({ passAt1: 0.4 }) });
    const cand = makeSnapshot({ taskA: behavior(), taskB: behavior({ passAt1: 0.4 }) });

    const result = fingerprintDiff(base, cand);

    expect(result.perTask).toHaveLength(2);
    expect(result.perTask.every((t) => t.verdict === "stable")).toBe(true);
    expect(result.summary.stable).toBe(2);
    expect(result.summary.drift).toBe(0);
    expect(result.summary.regress).toBe(0);
  });

  it("2. same pass@1 (overlapping CIs) + avgTurns/avgTokens +50% → drift, dims named", () => {
    const ci = { lo: 0.5, hi: 0.9 };
    const base = makeSnapshot(
      { taskA: behavior({ passAt1: 0.7, avgTurns: 4, avgTokens: 2000 }) },
      { taskA: { 1: ci } },
    );
    const cand = makeSnapshot(
      { taskA: behavior({ passAt1: 0.7, avgTurns: 6, avgTokens: 3000 }) }, // +50% both
      { taskA: { 1: ci } },
    );

    const result = fingerprintDiff(base, cand);

    expect(result.perTask).toHaveLength(1);
    const t = result.perTask[0]!;
    expect(t.verdict).toBe("drift");
    expect(t.notes.some((n) => n.includes("avgTurns"))).toBe(true);
    expect(t.notes.some((n) => n.includes("avgTokens"))).toBe(true);
    expect(result.summary.drift).toBe(1);
    expect(result.summary.regress).toBe(0);
  });

  it("3. same pass@1 + avgAttemptsUsed up (BoN cost) → drift (wins-via-more-retries case)", () => {
    const ci = { lo: 0.5, hi: 0.9 };
    const base = makeSnapshot(
      { taskA: behavior({ passAt1: 0.7, avgAttemptsUsed: 1.2 }) },
      { taskA: { 1: ci } },
    );
    const cand = makeSnapshot(
      { taskA: behavior({ passAt1: 0.7, avgAttemptsUsed: 2.4 }) }, // 2x
      { taskA: { 1: ci } },
    );

    const result = fingerprintDiff(base, cand);

    const t = result.perTask[0]!;
    expect(t.verdict).toBe("drift");
    expect(t.notes.some((n) => n.includes("avgAttemptsUsed"))).toBe(true);
  });

  it("4. pass@1 dropped + non-overlapping CIs → regress", () => {
    const base = makeSnapshot(
      { taskA: behavior({ passAt1: 0.9 }) },
      { taskA: { 1: { lo: 0.8, hi: 1.0 } } },
    );
    const cand = makeSnapshot(
      { taskA: behavior({ passAt1: 0.2 }) },
      { taskA: { 1: { lo: 0.05, hi: 0.35 } } },
    );

    const result = fingerprintDiff(base, cand);

    const t = result.perTask[0]!;
    expect(t.verdict).toBe("regress");
    expect(result.summary.regress).toBe(1);
    expect(result.summary.message).toContain("REGRESSED");
  });

  it("5. task missing perTaskBehavior in one snapshot → skipped/noted, not crashed", () => {
    const base = makeSnapshot({ taskA: behavior(), taskShared: behavior() });
    const cand = makeSnapshot({ taskB: behavior(), taskShared: behavior() });

    const result = fingerprintDiff(base, cand);

    // taskA (base-only) and taskB (cand-only) should both be skipped/noted.
    const skippedIds = result.perTask.filter((t) => t.notes.some((n) => n.startsWith("skipped"))).map((t) => t.taskId);
    expect(skippedIds).toContain("taskA");
    expect(skippedIds).toContain("taskB");
    expect(result.summary.skipped).toBe(2);
    // taskShared present in both, identical → stable.
    const shared = result.perTask.find((t) => t.taskId === "taskShared");
    expect(shared?.verdict).toBe("stable");
  });

  it("falls back to absolute-drop regression when CIs are unavailable", () => {
    const base = makeSnapshot({ taskA: behavior({ passAt1: 0.9 }) });
    const cand = makeSnapshot({ taskA: behavior({ passAt1: 0.5 }) }); // drop 0.4, no CI

    const result = fingerprintDiff(base, cand);
    const t = result.perTask[0]!;
    expect(t.verdict).toBe("regress");
    expect(t.notes[0]).toContain("fallback threshold");
  });

  it("small pass@1 drop without CI stays stable (below fallback threshold)", () => {
    const base = makeSnapshot({ taskA: behavior({ passAt1: 0.7 }) });
    const cand = makeSnapshot({ taskA: behavior({ passAt1: 0.65 }) }); // drop 0.05, no CI

    const result = fingerprintDiff(base, cand);
    const t = result.perTask[0]!;
    expect(t.verdict).not.toBe("regress");
  });

  it("tiny absolute cost movement below floor does not count as drift", () => {
    // repairRate 0.01 -> 0.02 is +100% relative but well under the absolute floor.
    const ci = { lo: 0.5, hi: 0.9 };
    const base = makeSnapshot(
      { taskA: behavior({ passAt1: 0.7, repairRate: 0.01 }) },
      { taskA: { 1: ci } },
    );
    const cand = makeSnapshot(
      { taskA: behavior({ passAt1: 0.7, repairRate: 0.02 }) },
      { taskA: { 1: ci } },
    );

    const result = fingerprintDiff(base, cand);
    expect(result.perTask[0]!.verdict).toBe("stable");
  });
});

// A lightweight typecheck sanity: this exercises that MetricsSnapshot's new
// optional perTaskBehavior field is assignable/omittable without breaking
// older-shaped snapshot objects (the real guarantee is enforced by `tsc`).
describe("MetricsSnapshot back-compat", () => {
  it("an old-shaped snapshot (no perTaskBehavior) is still a valid MetricsSnapshot", () => {
    const oldSnapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      runId: "live-old",
      suiteId: "suite-old",
      modelId: "old-model",
      overallPassAt1: 0.5,
      totalTasksPassed: 1,
      totalTasks: 2,
      perTaskPassAt1: { taskA: 0.5 },
    };
    expect(oldSnapshot.perTaskBehavior).toBeUndefined();

    const result = fingerprintDiff(oldSnapshot, oldSnapshot);
    expect(result.summary.stable + result.summary.drift + result.summary.regress + result.summary.skipped).toBe(0);
  });
});
