import { beforeEach, describe, expect, test } from "bun:test";
import {
  __setBunTestRunnerForTests,
  captureTestBaseline,
  runTieredOracle,
} from "../src/verify/oracle.ts";
import {
  formatOracleCostReport,
  getOracleCostStats,
  recordOracleCall,
  resetOracleCostStats,
} from "../src/verify/oracle-cost.ts";

/**
 * E6-T1: the oracle cost measuring stick. These tests pin two things — the
 * accounting is correct, and it is inert: recording a call must never move a
 * verdict. Model-free; the `bun test` spawn is replaced via the module-local
 * seam (never `mock.module`, which leaks across the whole suite process).
 */

const GREEN = "3 pass\n0 fail\n";
const RED = "(fail) thing > breaks [1ms]\n1 pass\n1 fail\n";

function fakeRun(output: string, durationMs: number) {
  return {
    state: output.includes("1 fail") ? ("red" as const) : ("green" as const),
    fullOutput: output,
    result: {
      kind: "test" as const,
      name: "bun-test",
      status: output.includes("1 fail") ? ("failed" as const) : ("passed" as const),
      output: output.slice(0, 4000),
      durationMs,
      exitCode: output.includes("1 fail") ? 1 : 0,
    },
  };
}

describe("oracle cost accounting", () => {
  beforeEach(() => {
    resetOracleCostStats();
    __setBunTestRunnerForTests(null);
  });

  test("starts empty and formats nothing when no oracle ran", () => {
    expect(getOracleCostStats()).toEqual({ calls: 0, totalMs: 0, byCallSite: {} });
    expect(formatOracleCostReport()).toBeNull();
  });

  test("accumulates calls and ms per call site", () => {
    recordOracleCall("baseline", 100);
    recordOracleCall("repair-candidate", 200);
    recordOracleCall("repair-candidate", 300);

    const stats = getOracleCostStats();
    expect(stats.calls).toBe(3);
    expect(stats.totalMs).toBe(600);
    expect(stats.byCallSite["repair-candidate"]).toEqual({ calls: 2, totalMs: 500 });
    expect(stats.byCallSite["baseline"]).toEqual({ calls: 1, totalMs: 100 });
  });

  test("reset zeroes everything", () => {
    recordOracleCall("per-turn", 50);
    resetOracleCostStats();
    expect(getOracleCostStats().calls).toBe(0);
  });

  test("getOracleCostStats returns a copy — callers cannot corrupt the accumulator", () => {
    recordOracleCall("per-turn", 50);
    const snapshot = getOracleCostStats();
    snapshot.calls = 999;
    const row = snapshot.byCallSite["per-turn"];
    if (row) row.totalMs = 999;
    expect(getOracleCostStats().calls).toBe(1);
    expect(getOracleCostStats().byCallSite["per-turn"]?.totalMs).toBe(50);
  });

  test("captureTestBaseline records under 'baseline' by default and honors an explicit tag", () => {
    __setBunTestRunnerForTests(() => fakeRun(GREEN, 42));

    captureTestBaseline("/repo");
    captureTestBaseline("/repo", "final-guard");
    captureTestBaseline("/repo", "restore-verify");

    const stats = getOracleCostStats();
    expect(stats.calls).toBe(3);
    expect(stats.totalMs).toBe(126);
    expect(stats.byCallSite["baseline"]?.calls).toBe(1);
    expect(stats.byCallSite["final-guard"]?.calls).toBe(1);
    expect(stats.byCallSite["restore-verify"]?.calls).toBe(1);
  });

  test("runTieredOracle records under the caller's tag, 'other' when untagged", async () => {
    __setBunTestRunnerForTests(() => fakeRun(GREEN, 10));

    await runTieredOracle("/repo", { callSite: "per-turn" });
    await runTieredOracle("/repo", { callSite: "repair-candidate" });
    await runTieredOracle("/repo", {});

    const stats = getOracleCostStats();
    expect(stats.calls).toBe(3);
    expect(stats.byCallSite["per-turn"]?.calls).toBe(1);
    expect(stats.byCallSite["repair-candidate"]?.calls).toBe(1);
    expect(stats.byCallSite["other"]?.calls).toBe(1);
  });

  test("accounting is inert: verdicts are identical with counters hot or freshly reset", async () => {
    __setBunTestRunnerForTests(() => fakeRun(GREEN, 10));
    const cold = await runTieredOracle("/repo", { callSite: "per-turn" });
    for (let i = 0; i < 25; i++) recordOracleCall("repair-candidate", 1000);
    const hot = await runTieredOracle("/repo", { callSite: "per-turn" });

    expect(cold.outcome).toBe("solved");
    expect(hot.outcome).toBe(cold.outcome);
    expect(hot.feedback).toBe(cold.feedback);

    // ...and a red verdict is still red, with the same regression signal.
    __setBunTestRunnerForTests(() => fakeRun(RED, 10));
    const red = await runTieredOracle("/repo", { callSite: "per-turn" });
    expect(red.outcome).toBe("failing");
    expect(red.regressed).toBe(true);
  });

  test("report breaks out call sites, sorted by total time descending", () => {
    recordOracleCall("baseline", 1_000);
    recordOracleCall("repair-candidate", 9_000);

    const report = formatOracleCostReport();
    expect(report).toContain("2 call(s), 10.0s total");
    expect(report).toContain("repair-candidate");
    expect(report).toContain("90%");
    // Dominant cost first — that is the whole point of the table.
    const lines = (report ?? "").split("\n");
    expect(lines[1]).toContain("repair-candidate");
    expect(lines[2]).toContain("baseline");
  });
});
