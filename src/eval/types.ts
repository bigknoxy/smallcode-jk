import type { TurnRecord } from "../agent/types.ts";

// ---------------------------------------------------------------------------
// Task definition (loaded from YAML)
// ---------------------------------------------------------------------------

export interface TaskSetup {
  repoFixture?: string; // path relative to evals/fixtures/
  files?: Record<string, string>; // inline file contents to write
}

export type GraderType = "deterministic_tests" | "static_analysis" | "llm_rubric";

export interface DeterministicTestsGrader {
  type: "deterministic_tests";
  required: string[]; // test file names that must pass (fail-to-pass + pass-to-pass)
  command?: string; // default: "bun test"
}

export interface StaticAnalysisGrader {
  type: "static_analysis";
  commands: string[]; // e.g. ["biome", "tsc"] — run as Bun.spawnSync
}

export interface LLMRubricGrader {
  type: "llm_rubric";
  rubric: string; // path to rubric markdown file, or inline text
  dimensions?: string[]; // one judge per dimension for isolation
}

export type GraderConfig = DeterministicTestsGrader | StaticAnalysisGrader | LLMRubricGrader;

export interface EvalTask {
  id: string;
  desc: string;
  setup: TaskSetup;
  graders: GraderConfig[];
  trackedMetrics: string[]; // e.g. ["n_turns", "n_toolcalls", "n_total_tokens", "pass_at_1"]
  referenceSolution?: string; // path relative to evals/fixtures/ for the known-good state
  tags?: string[]; // e.g. ["regression", "capability", "typescript"]
}

// ---------------------------------------------------------------------------
// Grader results
// ---------------------------------------------------------------------------

export type GraderVerdict = "pass" | "fail" | "partial" | "unknown" | "error";

export interface GraderResult {
  type: GraderType;
  verdict: GraderVerdict;
  score: number; // 0–1
  output: string; // raw output, truncated
  durationMs: number;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface Transcript {
  id: string; // unique transcript ID
  sessionId: string;
  taskId: string;
  trialIndex: number;
  modelId: string;
  turns: TurnRecord[];
  outcome: "passed" | "failed" | "error" | "timeout";
  startedAt: number;
  finishedAt: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Trial result
// ---------------------------------------------------------------------------

export interface TrialMetrics {
  nTurns: number;
  nToolCalls: number;
  nTotalTokens: number;
  nPromptTokens: number;
  nCompletionTokens: number;
  latencyMs: number;
  /** R5: 1 if any turn applied a parseable edit cleanly, else 0 (edit-format-%). */
  editFormatOk?: number;
  [key: string]: number | undefined;
}

export interface TrialResult {
  taskId: string;
  trialIndex: number;
  passed: boolean;
  partialScore: number; // 0–1; 1.0 = all graders pass
  graderResults: GraderResult[];
  transcript: Transcript;
  metrics: TrialMetrics;
  error?: string;
  /** Best-of-N only: independent attempts run before this trial resolved (≤ N,
   * stops on first deterministic-green). 1 (or undefined) for a plain trial. */
  attemptsUsed?: number;
  /** R1 escalation only: model id that produced the resolving (or final) attempt
   * — which ladder rung actually solved it. Undefined when no ladder was used. */
  winningModelId?: string;
}

// ---------------------------------------------------------------------------
// Eval run results + metrics
// ---------------------------------------------------------------------------

/** 95% confidence interval for a pass@k estimate (bootstrap; see eval/stats.ts). */
export interface PassAtKCI {
  lo: number;
  hi: number;
  /** True when n was too small (<2) to bootstrap a meaningful interval. */
  degenerate?: boolean;
}

export interface TaskEvalResult {
  task: EvalTask;
  trials: TrialResult[];
  passAt1: number; // fraction of single trials that passed (headline metric)
  passAtK: Record<number, number>; // passAt[k] = P(at least 1 success in k trials)
  passAllK: number; // pass^k = P(all k trials pass)
  avgPartialScore: number;
  avgMetrics: TrialMetrics;
  // --- Additive (measuring-stick rebuild); optional for backward compat. ---
  /** Sample count = trials.length (decoupled from the reported k set). */
  n?: number;
  /** 95% bootstrap CI per reported k, parallel to passAtK. */
  passAtKCI?: Record<number, PassAtKCI>;
  /** Best-of-N: attempts allowed per trial (N). 1/undefined = plain single-shot. */
  bestOfN?: number;
  /** Best-of-N: mean attempts actually spent per trial (cost; ≤ bestOfN thanks
   * to first-green short-circuit). undefined when bestOfN ≤ 1. */
  avgAttemptsUsed?: number;
}

export interface EvalRunResult {
  runId: string;
  suiteId: string;
  modelId: string;
  taskResults: TaskEvalResult[];
  overallPassAt1: number;
  totalTrials: number;
  totalTasksPassed: number;
  startedAt: number;
  finishedAt: number;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export type SuiteKind = "capability" | "regression" | "mixed";

export interface EvalSuite {
  id: string;
  kind: SuiteKind;
  description: string;
  tasks: EvalTask[];
  defaultTrials: number; // how many trials per task
}
