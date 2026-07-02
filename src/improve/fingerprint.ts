/**
 * fingerprint.ts — behavioral/cost drift detection between two eval runs
 * (P1#4 in docs/harness-engineering-roadmap.md, AgentAssay idea).
 *
 * Complements (does not replace) the pass@k CI comparison in compare-runs.ts.
 * That comparison answers "did success rate change?" This module answers a
 * different question that pass@k CIs structurally cannot: "did the COST of
 * getting that success rate change?" A prompt change that wins by burning
 * more Best-of-N retries or more turns per trial can leave pass@1 statistically
 * unchanged while quietly making every run more expensive — the "same success,
 * worse cost profile" blind spot.
 *
 * Pure, deterministic, no I/O. Operates only on MetricsSnapshot.perTaskBehavior,
 * which is optional and only populated on runs recorded after this feature
 * shipped — see the VALIDATION LIMITATION note in the PR description for how
 * that affects retro-comparisons against pre-existing metrics-history.jsonl rows.
 */

import type { MetricsSnapshot, SnapshotCI, TaskBehavior } from "./types.ts";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * When per-task pass@1 CIs are unavailable (older/incomplete snapshots), fall
 * back to flagging "regress" on a raw pass@1 drop of at least this much. This
 * is a much cruder test than CI non-overlap — it exists only so the function
 * degrades rather than silently skipping the regression check.
 */
export const REGRESS_ABS_FALLBACK_THRESHOLD = 0.15;

/**
 * A cost dimension counts as "drifted" when it increases by at least this
 * fraction relative to the baseline value. 0.30 = +30%. Chosen to sit clearly
 * above normal single-run noise for turns/tokens while still catching a
 * meaningful "wins via more retries" shift (e.g. avgAttemptsUsed 1.2 → 1.6).
 */
export const DRIFT_REL_THRESHOLD = 0.3;

/**
 * Absolute floor below which a cost dimension is ignored for drift purposes,
 * even if its relative change exceeds DRIFT_REL_THRESHOLD. Guards against a
 * tiny baseline (e.g. repairRate 0.01 → 0.02) registering as "+100% drift"
 * when the absolute cost impact is negligible.
 */
const DRIFT_ABS_FLOORS: Record<CostDim, number> = {
  avgTurns: 0.5,
  avgTokens: 200,
  avgAttemptsUsed: 0.1,
  repairRate: 0.05,
  thinkOnlyRate: 0.05,
};

type CostDim = "avgTurns" | "avgTokens" | "avgAttemptsUsed" | "repairRate" | "thinkOnlyRate";
const COST_DIMS: CostDim[] = ["avgTurns", "avgTokens", "avgAttemptsUsed", "repairRate", "thinkOnlyRate"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskDrift {
  taskId: string;
  verdict: "stable" | "drift" | "regress";
  /** candidate - baseline, per dimension (pass@1 and each cost dim present in both). */
  deltas: Record<string, number>;
  notes: string[];
}

export interface FingerprintSummary {
  stable: number;
  drift: number;
  regress: number;
  skipped: number;
  message: string;
}

export interface FingerprintDiffResult {
  perTask: TaskDrift[];
  summary: FingerprintSummary;
}

export interface FingerprintDiffOptions {
  driftRelThreshold?: number;
  regressAbsFallbackThreshold?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two 95% CIs are significantly different iff they do NOT overlap (mirrors
 * compare-runs.ts's overlap()). */
function ciNonOverlap(a: SnapshotCI, b: SnapshotCI): boolean {
  return a.hi < b.lo || b.hi < a.lo;
}

/** Relative increase of `cand` over `base`, guarding base===0 (treat any
 * positive candidate value as infinite relative increase, gated separately
 * by the absolute floor). */
function relIncrease(base: number, cand: number): number {
  if (base === 0) return cand > 0 ? Infinity : 0;
  return (cand - base) / base;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export function fingerprintDiff(
  baseline: MetricsSnapshot,
  candidate: MetricsSnapshot,
  opts?: FingerprintDiffOptions,
): FingerprintDiffResult {
  const driftRelThreshold = opts?.driftRelThreshold ?? DRIFT_REL_THRESHOLD;
  const regressAbsFallback = opts?.regressAbsFallbackThreshold ?? REGRESS_ABS_FALLBACK_THRESHOLD;

  const baseBehavior = baseline.perTaskBehavior ?? {};
  const candBehavior = candidate.perTaskBehavior ?? {};

  const allTaskIds = [...new Set([...Object.keys(baseBehavior), ...Object.keys(candBehavior)])].sort();

  const perTask: TaskDrift[] = [];
  let stable = 0;
  let drift = 0;
  let regress = 0;
  let skipped = 0;

  for (const taskId of allTaskIds) {
    const b = baseBehavior[taskId];
    const c = candBehavior[taskId];
    if (!b || !c) {
      perTask.push({
        taskId,
        verdict: "stable",
        deltas: {},
        notes: [`skipped: missing perTaskBehavior in ${!b ? "baseline" : "candidate"} snapshot (pre-fingerprint run?)`],
      });
      skipped++;
      continue;
    }

    const notes: string[] = [];
    const deltas: Record<string, number> = { passAt1: c.passAt1 - b.passAt1 };

    // --- Regression check: pass@1 dropped AND (CIs confirm it | fallback threshold). ---
    const bCI = baseline.perTaskCI?.[taskId]?.[1];
    const cCI = candidate.perTaskCI?.[taskId]?.[1];
    const passDropped = c.passAt1 < b.passAt1;
    let isRegress = false;
    if (passDropped && bCI && cCI) {
      if (ciNonOverlap(bCI, cCI)) {
        isRegress = true;
        notes.push(
          `pass@1 dropped ${b.passAt1.toFixed(2)} → ${c.passAt1.toFixed(2)} with non-overlapping 95% CIs [${bCI.lo.toFixed(2)}-${bCI.hi.toFixed(2)}] vs [${cCI.lo.toFixed(2)}-${cCI.hi.toFixed(2)}]`,
        );
      }
    } else if (passDropped && (!bCI || !cCI)) {
      // No CI available on one or both sides — fall back to an absolute-drop
      // threshold. Cruder than the CI test; documented in the constant comment.
      if (b.passAt1 - c.passAt1 >= regressAbsFallback) {
        isRegress = true;
        notes.push(
          `pass@1 dropped ${b.passAt1.toFixed(2)} → ${c.passAt1.toFixed(2)} (≥${regressAbsFallback} fallback threshold; CI unavailable for a proper significance test)`,
        );
      }
    }

    if (isRegress) {
      for (const dim of COST_DIMS) {
        const bv = b[dim];
        const cv = c[dim];
        if (bv !== undefined && cv !== undefined) deltas[dim] = cv - bv;
      }
      perTask.push({ taskId, verdict: "regress", deltas, notes });
      regress++;
      continue;
    }

    // --- Drift check: pass@1 unchanged (statistically or within threshold) but
    // ≥1 cost dim moved beyond DRIFT_REL_THRESHOLD (and past its absolute floor). ---
    const driftedDims: string[] = [];
    for (const dim of COST_DIMS) {
      const bv = b[dim];
      const cv = c[dim];
      if (bv === undefined || cv === undefined) continue;
      deltas[dim] = cv - bv;
      const rel = relIncrease(bv, cv);
      const absDelta = cv - bv;
      if (rel >= driftRelThreshold && Math.abs(absDelta) >= DRIFT_ABS_FLOORS[dim]) {
        driftedDims.push(dim);
        notes.push(
          `${dim} up ${(rel * 100).toFixed(0)}% (${bv.toFixed(2)} → ${cv.toFixed(2)}) — same success, higher cost`,
        );
      }
    }

    if (driftedDims.length > 0) {
      perTask.push({ taskId, verdict: "drift", deltas, notes });
      drift++;
    } else {
      perTask.push({ taskId, verdict: "stable", deltas, notes: ["no cost dim moved beyond threshold"] });
      stable++;
    }
  }

  const message =
    regress > 0
      ? `${regress} task(s) REGRESSED (real pass@1 drop), ${drift} drifted (same success, higher cost), ${stable} stable${skipped ? `, ${skipped} skipped (no behavioral data)` : ""}.`
      : drift > 0
        ? `No pass@1 regressions. ${drift} task(s) DRIFTED — same success rate, worse cost profile. ${stable} stable${skipped ? `, ${skipped} skipped` : ""}.`
        : `No behavioral drift detected. ${stable} stable task(s)${skipped ? `, ${skipped} skipped (no behavioral data)` : ""}.`;

  return {
    perTask,
    summary: { stable, drift, regress, skipped, message },
  };
}

export type { TaskBehavior };
