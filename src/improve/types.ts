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

export interface MetricsSnapshot {
  timestamp: number;
  runId: string;
  suiteId: string;
  modelId: string;
  overallPassAt1: number;
  totalTasksPassed: number;
  totalTasks: number;
  perTaskPassAt1: Record<string, number>; // taskId → pass@1
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
