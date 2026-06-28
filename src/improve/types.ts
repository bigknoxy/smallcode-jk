import type { EvalRunResult, EvalTask, TaskEvalResult } from "../eval/types.ts";

// ---------------------------------------------------------------------------
// Session logging
// ---------------------------------------------------------------------------

export interface SessionLogEntry {
  sessionId: string;
  taskDesc: string;
  repoRoot: string;
  modelId: string;
  outcome: "done" | "failed" | "max_turns" | "abandoned" | "error";
  nTurns: number;
  nTokens: number;
  latencyMs: number;
  transcriptPath: string; // where the full transcript was saved
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Candidate task (promoted from a failed session)
// ---------------------------------------------------------------------------

export interface CandidateTask {
  id: string;
  sourceSessionId: string;
  sourceTranscriptPath: string;
  task: EvalTask; // ready to write as JSON to a suite directory
  promotedAt: number;
  notes?: string; // why this was promoted / what failed
}

// ---------------------------------------------------------------------------
// Metrics history
// ---------------------------------------------------------------------------

/** 95% CI bounds persisted in a snapshot (mirrors eval/stats.ts CI). */
export interface SnapshotCI {
  lo: number;
  hi: number;
}

export interface MetricsSnapshot {
  timestamp: number;
  runId: string;
  suiteId: string;
  modelId: string;
  overallPassAt1: number;
  totalTasksPassed: number;
  totalTasks: number;
  perTaskPassAt1: Record<string, number>; // taskId → pass@1
  // --- Additive (measuring-stick rebuild); all optional for backward compat
  // with existing metrics-history.jsonl rows and readers. ---
  /** Sample count n per task this run. */
  n?: number;
  /** k values reported, e.g. [1,2,3,5]. */
  reportKs?: number[];
  /** taskId → k → pass@k point estimate. */
  perTaskPassAtK?: Record<string, Record<number, number>>;
  /** taskId → k → 95% bootstrap CI. */
  perTaskCI?: Record<string, Record<number, SnapshotCI>>;
  /** Suite-level pooled pass@k point estimate per k. */
  overallPassAtK?: Record<number, number>;
  /** Suite-level pooled 95% CI per k. */
  overallCI?: Record<number, SnapshotCI>;
  /** Total think-only (truncated mid-reasoning) turns across the run. */
  thinkOnlyTotal?: number;
  /** Total trials that hit ≥1 think-only truncation. */
  trialsWithTruncationTotal?: number;
  /** Sampling overrides in effect, so history rows are self-describing. */
  sampling?: { temp?: number; maxTokens?: number };
  /** Run-level Best-of-N: attempts allowed per trial (1/undefined = single-shot).
   * When >1, overallPassAtK[1] is the empirical pass@N(any) of the BoN mechanism. */
  bestOfN?: number;
  /** Mean BoN attempts spent per trial across the run (cost; undefined when off). */
  avgAttemptsUsed?: number;
}

export interface MetricsHistory {
  suiteId: string;
  snapshots: MetricsSnapshot[];
}

// ---------------------------------------------------------------------------
// Regression gate
// ---------------------------------------------------------------------------

export interface RegressionCheckResult {
  passed: boolean;
  baselinePassAt1: number;
  currentPassAt1: number;
  delta: number; // current - baseline
  regressedTasks: string[]; // task IDs that newly fail
  threshold: number; // configured minimum pass@1
  message: string;
}

// ---------------------------------------------------------------------------
// A/B comparison
// ---------------------------------------------------------------------------

export interface ABVariant {
  name: string;
  systemPrompt: string;
}

export interface ABResult {
  variantA: ABVariant;
  variantB: ABVariant;
  runA: EvalRunResult;
  runB: EvalRunResult;
  winner: "A" | "B" | "tie";
  deltaPassAt1: number; // B.passAt1 - A.passAt1
  perTaskDelta: Record<string, number>; // taskId → B.pass@1 - A.pass@1
  summary: string;
}

// Imported for convenience
export type { EvalRunResult, EvalTask, TaskEvalResult };
