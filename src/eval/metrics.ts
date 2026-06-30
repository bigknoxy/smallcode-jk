import type { Transcript, TrialMetrics, TrialResult } from "./types.ts";

export function collectMetrics(transcript: Transcript): TrialMetrics {
  let nToolCalls = 0;
  let nPromptTokens = 0;
  let nCompletionTokens = 0;
  // editFormatOk = did the model produce, on ANY turn, an edit block that PARSED
  // and APPLIED cleanly? This is the Aider-leaderboard "correct edit format" axis
  // — averaged across trials it gives the edit-format-success %, the metric that
  // most directly tracks smallcode's harness thesis (a weak model fails on edit
  // format, not reasoning). Independent of whether the tests ultimately passed.
  let editFormatOk = 0;
  for (const turn of transcript.turns) {
    nToolCalls += turn.toolCalls.length;
    nPromptTokens += turn.promptTokens;
    nCompletionTokens += turn.completionTokens;
    if (turn.applyResults.some((ar) => ar.status === "applied")) editFormatOk = 1;
  }

  return {
    nTurns: transcript.turns.length,
    nToolCalls,
    nTotalTokens: nPromptTokens + nCompletionTokens,
    nPromptTokens,
    nCompletionTokens,
    latencyMs: transcript.finishedAt - transcript.startedAt,
    editFormatOk,
  };
}

export function averageMetrics(metrics: TrialMetrics[]): TrialMetrics {
  if (metrics.length === 0) {
    return {
      nTurns: 0,
      nToolCalls: 0,
      nTotalTokens: 0,
      nPromptTokens: 0,
      nCompletionTokens: 0,
      latencyMs: 0,
    };
  }

  // Collect all keys across all metrics
  const allKeys = new Set<string>();
  for (const m of metrics) {
    for (const key of Object.keys(m)) {
      allKeys.add(key);
    }
  }

  const result: TrialMetrics = {
    nTurns: 0,
    nToolCalls: 0,
    nTotalTokens: 0,
    nPromptTokens: 0,
    nCompletionTokens: 0,
    latencyMs: 0,
  };

  for (const key of allKeys) {
    let sum = 0;
    for (const m of metrics) {
      sum += m[key] ?? 0;
    }
    result[key] = sum / metrics.length;
  }

  return result;
}

/**
 * Compute the unbiased pass@k estimator.
 * P(at least 1 success in k trials) = 1 - C(n-c, k) / C(n, k)
 * where n = total trials, c = passing trials
 */
export function computePassAtK(trials: TrialResult[], k: number): number {
  if (trials.length === 0) return 0;

  const n = trials.length;
  const c = trials.filter((t) => t.passed).length;

  // Clamp k to [1, n]
  const kClamped = Math.max(1, Math.min(k, n));

  if (c === 0) return 0;
  if (c === n) return 1;

  // Compute C(n-c, k) / C(n, k) using log-space to avoid overflow
  // C(n-c, k) / C(n, k) = product_{i=0}^{k-1} (n-c-i)/(n-i)
  const nc = n - c;
  if (nc < kClamped) {
    // n-c < k means C(n-c, k) = 0, so pass@k = 1
    return 1;
  }

  let ratio = 1;
  for (let i = 0; i < kClamped; i++) {
    ratio *= (nc - i) / (n - i);
  }

  return 1 - ratio;
}

/**
 * Fraction of all trials that passed (pass^k — all k succeed).
 */
export function computePassAllK(trials: TrialResult[]): number {
  if (trials.length === 0) return 0;
  const passing = trials.filter((t) => t.passed).length;
  return passing / trials.length;
}
