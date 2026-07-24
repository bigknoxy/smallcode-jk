import { describe, expect, it } from "bun:test";
import { skipReason, summarizeSwebench } from "../src/eval/swebench-report.ts";

/**
 * E3-T2 — the honest SWE-bench-Lite report. The load-bearing rule: never invent a
 * pass rate for env-unavailable instances; pass@1 is reported ONLY over the
 * runnable subset, always with the skip breakdown.
 */
describe("skipReason", () => {
  it("categorizes by the parenthetical reason", () => {
    expect(skipReason("astropy__x (env-unavailable: deps not importable here)")).toBe("env-unavailable");
    expect(skipReason("foo (clone failed)")).toBe("clone-failed");
    expect(skipReason("foo (checkout failed)")).toBe("checkout-failed");
    expect(skipReason("foo (test_patch apply failed)")).toBe("patch-failed");
    expect(skipReason("foo (weird)")).toBe("other");
  });
});

describe("summarizeSwebench", () => {
  it("0 runnable → honest 'no pass-rate reported', never a fake 0", () => {
    const { lines, skipsByReason } = summarizeSwebench({
      total: 3,
      runnable: 0,
      passed: 0,
      editFmt: 0,
      rescued: 0,
      skipped: ["a (env-unavailable: x)", "b (env-unavailable: x)", "c (clone failed)"],
    });
    expect(skipsByReason).toEqual({ "env-unavailable": 2, "clone-failed": 1 });
    expect(lines.some((l) => l.includes("runnable here: 0/3"))).toBe(true);
    expect(lines.some((l) => l.includes("skip breakdown: 2 env-unavailable, 1 clone-failed"))).toBe(true);
    expect(lines.some((l) => l.includes("No pass-rate reported"))).toBe(true);
    // Crucially: no fabricated pass@1 line when nothing ran.
    expect(lines.some((l) => /pass@1/.test(l))).toBe(false);
  });

  it("runnable subset → pass@1 over the subset ONLY + edit-format + how-solved split", () => {
    const { lines } = summarizeSwebench({
      total: 10,
      runnable: 4,
      passed: 3,
      editFmt: 4,
      rescued: 1,
      skipped: ["x (env-unavailable: y)"],
    });
    // 3/4 = 0.75 over the RUNNABLE subset, not 3/10.
    expect(lines.some((l) => l.includes("pass@1 (runnable subset): 0.75 (3/4)"))).toBe(true);
    expect(lines.some((l) => l.includes("edit-format: 100%"))).toBe(true);
    // Attribution: 2 model-solved, 1 harness-rescued of 3 passing.
    expect(lines.some((l) => l.includes("how solved: 2 model-solved, 1 harness-rescued"))).toBe(true);
  });

  it("the pass@1 denominator is runnable, never total — the rate can't be overstated", () => {
    const { lines } = summarizeSwebench({ total: 100, runnable: 2, passed: 2, editFmt: 2, rescued: 0, skipped: [] });
    const passLine = lines.find((l) => /pass@1/.test(l))!;
    expect(passLine).toContain("1.00 (2/2)"); // divides by runnable (2), not total (100)
    expect(passLine).not.toContain("/100");
    // The coverage line DOES show /total (2/100) — that's honest, not a rate.
    expect(lines.some((l) => l.includes("runnable here: 2/100"))).toBe(true);
  });
});
