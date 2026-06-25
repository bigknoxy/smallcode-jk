/**
 * Statistics for the eval measuring stick.
 *
 * The eval harness samples a stochastic model (temp≈1.0) a small number of
 * times per task. With only n=5 samples and pass@1 reported as the raw fraction
 * c/n, a true rate of 0.7 renders as 1.00 or 0.40 run-to-run — effects smaller
 * than the noise floor are invisible. This module makes results trustworthy by
 * attaching a 95% bootstrap confidence interval to every pass@k point estimate,
 * so signal can be told from noise (non-overlapping CIs ≈ significant).
 *
 * It builds on the existing unbiased estimator `computePassAtK` (metrics.ts);
 * that math is not reimplemented here.
 */

import { computePassAtK } from "./metrics.ts";
import type { TaskEvalResult, TrialResult } from "./types.ts";

export interface CI {
  lo: number;
  hi: number;
  /** True when n was too small to bootstrap a meaningful interval (n < 2). */
  degenerate?: boolean;
}

/**
 * mulberry32 — a tiny deterministic PRNG. A fixed seed makes bootstrap CIs
 * reproducible across reruns of the same trial outcomes, so a CI never shifts
 * just because the resampler drew differently.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Point estimate of pass@k from raw pass/fail flags (wraps computePassAtK). */
export function passAtKFromFlags(passedFlags: boolean[], k: number): number {
  // computePassAtK only reads `.passed`; build minimal stubs.
  const stubs = passedFlags.map((passed) => ({ passed }) as TrialResult);
  return computePassAtK(stubs, k);
}

/**
 * Bootstrap a 95% CI for pass@k over n binary trial outcomes.
 *
 * Resamples `passedFlags` n-with-replacement `iters` times, recomputes pass@k
 * for each resample via the unbiased estimator, and returns the [α/2, 1−α/2]
 * percentiles. Deterministic given the seed.
 *
 * Edge cases (the honesty guarantees):
 *  - n < 2          → bootstrap is meaningless; return the point estimate as a
 *                     zero-width interval flagged `degenerate` so callers can
 *                     print "n too small for CI".
 *  - c = 0 or c = n → every resample yields the same value, so the CI collapses
 *                     to a point. This is honest for the *resample* but
 *                     understates the true uncertainty (a run of n all-fails
 *                     does not prove rate 0). The real defense is a larger n.
 *  // TODO Wilson interval for the c∈{0,n} tails, where bootstrap degenerates.
 */
export function bootstrapCI(
  passedFlags: boolean[],
  k: number,
  opts?: { iters?: number; seed?: number; alpha?: number },
): CI {
  const n = passedFlags.length;
  const point = passAtKFromFlags(passedFlags, k);
  if (n < 2) {
    return { lo: point, hi: point, degenerate: true };
  }

  const iters = opts?.iters ?? 2000;
  const alpha = opts?.alpha ?? 0.05;
  const rng = makeRng(opts?.seed ?? 0xc0ffee);

  const estimates: number[] = new Array(iters);
  const resample: boolean[] = new Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      resample[i] = passedFlags[idx] ?? false;
    }
    estimates[it] = passAtKFromFlags(resample, k);
  }
  estimates.sort((x, y) => x - y);

  const loIdx = Math.floor((alpha / 2) * iters);
  const hiIdx = Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1);
  return { lo: estimates[loIdx] ?? point, hi: estimates[hiIdx] ?? point };
}

export interface SuiteAggregate {
  /** Pooled pass@k point estimate per requested k. */
  overallPassAtK: Record<number, number>;
  /** Pooled 95% bootstrap CI per requested k. */
  overallCI: Record<number, CI>;
  /** Total pooled trials (sum of each task's n). */
  nPooled: number;
}

/**
 * Suite-level aggregation by POOLING every task's trial outcomes into one
 * sample, then computing pass@k + CI over the pool. Pooling weights tasks by
 * trial count (equal when every task runs the same n). This answers "across all
 * task-trials, what is pass@k" — the headline a run reports.
 *
 * (Alternative not implemented: mean of per-task rates with a CI bootstrapped
 * over tasks, which answers "typical task" and matters only if per-task n
 * diverges. // TODO if task weighting ever needs to differ.)
 */
export function aggregateSuite(
  taskResults: Pick<TaskEvalResult, "trials">[],
  ks: number[],
  opts?: { iters?: number; seed?: number },
): SuiteAggregate {
  const pooled: boolean[] = [];
  for (const tr of taskResults) {
    for (const t of tr.trials) pooled.push(t.passed);
  }
  const overallPassAtK: Record<number, number> = {};
  const overallCI: Record<number, CI> = {};
  for (const k of ks) {
    if (k > pooled.length) continue;
    overallPassAtK[k] = passAtKFromFlags(pooled, k);
    overallCI[k] = bootstrapCI(pooled, k, opts);
  }
  return { overallPassAtK, overallCI, nPooled: pooled.length };
}
