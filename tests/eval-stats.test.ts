/**
 * Tests for the eval statistics layer (src/eval/stats.ts) — the measuring-stick
 * rebuild. These guarantee the confidence intervals are reproducible, bracket
 * their point estimate, degenerate honestly at the c∈{0,n} and n<2 tails, and
 * actually tighten as the sample count grows (the whole point: more samples →
 * less noise).
 */

import { describe, expect, it } from "bun:test";
import {
  aggregateSuite,
  bootstrapCI,
  makeRng,
  passAtKFromFlags,
} from "../src/eval/stats.ts";

const flags = (c: number, n: number): boolean[] =>
  Array.from({ length: n }, (_, i) => i < c);

describe("makeRng", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(123);
    const b = makeRng(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("produces values in [0,1)", () => {
    const r = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("passAtKFromFlags", () => {
  it("matches the unbiased estimator at k=1 (= c/n)", () => {
    expect(passAtKFromFlags(flags(3, 10), 1)).toBeCloseTo(0.3, 10);
  });
  it("rises with k (more tries → more likely ≥1 success)", () => {
    const f = flags(3, 10);
    expect(passAtKFromFlags(f, 5)).toBeGreaterThan(passAtKFromFlags(f, 1));
  });
});

describe("bootstrapCI", () => {
  it("is deterministic given a fixed seed", () => {
    const f = flags(5, 12);
    const a = bootstrapCI(f, 1, { seed: 42, iters: 500 });
    const b = bootstrapCI(f, 1, { seed: 42, iters: 500 });
    expect(a).toEqual(b);
  });

  it("brackets the point estimate", () => {
    const f = flags(7, 20);
    const point = passAtKFromFlags(f, 1);
    const ci = bootstrapCI(f, 1, { seed: 1 });
    expect(ci.lo).toBeLessThanOrEqual(point + 1e-9);
    expect(ci.hi).toBeGreaterThanOrEqual(point - 1e-9);
  });

  it("collapses to a point when c=0 (all failed)", () => {
    const ci = bootstrapCI(flags(0, 10), 1, { seed: 1 });
    expect(ci.lo).toBe(0);
    expect(ci.hi).toBe(0);
  });

  it("collapses to a point when c=n (all passed)", () => {
    const ci = bootstrapCI(flags(10, 10), 1, { seed: 1 });
    expect(ci.lo).toBe(1);
    expect(ci.hi).toBe(1);
  });

  it("flags n<2 as degenerate (cannot bootstrap)", () => {
    const ci = bootstrapCI([true], 1, { seed: 1 });
    expect(ci.degenerate).toBe(true);
    expect(ci.lo).toBe(ci.hi);
  });

  it("CI WIDTH SHRINKS as n grows at the same true rate (the core promise)", () => {
    // p = 0.5 in both, but n=40 should give a tighter interval than n=8.
    const wide = bootstrapCI(flags(4, 8), 1, { seed: 9 });
    const tight = bootstrapCI(flags(20, 40), 1, { seed: 9 });
    expect(tight.hi - tight.lo).toBeLessThan(wide.hi - wide.lo);
  });
});

describe("aggregateSuite", () => {
  it("pools trial outcomes across tasks and reports pass@k + CI", () => {
    const taskResults = [
      { trials: flags(2, 5).map((passed) => ({ passed })) as any },
      { trials: flags(3, 5).map((passed) => ({ passed })) as any },
    ];
    const agg = aggregateSuite(taskResults, [1, 3], { iters: 300, seed: 5 });
    expect(agg.nPooled).toBe(10);
    // pooled c=5, n=10 → pass@1 = 0.5
    expect(agg.overallPassAtK[1]).toBeCloseTo(0.5, 10);
    expect(agg.overallCI[1]?.lo).toBeLessThanOrEqual(0.5);
    expect(agg.overallCI[1]?.hi).toBeGreaterThanOrEqual(0.5);
    expect(agg.overallPassAtK[3]).toBeGreaterThan(agg.overallPassAtK[1] ?? 0);
  });
});
