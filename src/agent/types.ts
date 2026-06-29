import type { ApplyResult, EditBlock } from "../edit/types.ts";
import type { FailureDiagnostic } from "../verify/failure-extract.ts";
import type { PromptSet } from "./prompt-set.ts";

export type GoalStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";
export type SessionStatus = "running" | "done" | "failed" | "max_turns" | "abandoned";
export type ToolName =
  | "read_file"
  | "write_file"
  | "run_command"
  | "run_tests"
  | "finish"
  | "think";

export interface Goal {
  id: string;
  description: string;
  status: GoalStatus;
  completedAt?: number;
  error?: string;
}

export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: ToolName;
  success: boolean;
  output: string;
  error?: string;
  durationMs?: number;
}

export interface TurnRecord {
  turn: number;
  goalId: string;
  prompt: string;
  rawResponse: string;
  reasoning?: string; // extracted from <think> tags
  answer: string; // response with reasoning stripped
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  editBlocks: EditBlock[];
  applyResults: ApplyResult[];
  promptTokens: number;
  completionTokens: number;
  timestamp: number;
  /** Stable failure signature for stall detection (set when oracle returns failing). */
  failureSignature?: string;
  /** True when this turn triggered a redraft (cleared history, rotated strategy). */
  redrafted?: boolean;
  /**
   * True when this turn was drafted under the ANSWER-NOW recovery prompt — the
   * previous turn truncated mid-reasoning (think-only) and emitted no answer, so
   * this turn was told to skip thinking and act immediately.
   */
  answerNow?: boolean;
  /** Structured diagnostic for this turn's failure, if any. */
  diagnostic?: FailureDiagnostic;
  /**
   * R2 externalize-localization. When a failure's stack trace reached a source
   * line (a runtime throw), the loop reads a tight window around it and stores it
   * here so the next prompt can show the model the EXACT line that failed — the
   * `where` a small model cannot localize itself. Only set when
   * SMALLCODE_LOCALIZE is enabled and a source frame was present.
   */
  failureLocation?: { file: string; line: number; window: string };
  /**
   * Set when this turn's applied edit was ROLLED BACK because it regressed
   * previously-green tests. `newFailures` lists the tests that flipped red. The
   * edited files have been restored to their pre-turn content, so the next
   * prompt surfaces a warning and tells the model to re-edit only the target.
   * Only present on a true regression (verdict.newFailures non-empty) — a still-
   * red suite with no new failures is NOT a revert.
   */
  reverted?: { newFailures: string[] };
}

export interface AgentState {
  sessionId: string;
  task: string;
  repoRoot: string;
  modelId: string;
  goals: Goal[];
  currentGoalIndex: number;
  turns: TurnRecord[];
  status: SessionStatus;
  scratchpad: string; // free-form notes the model can read/write
  startedAt: number;
  updatedAt: number;
  maxTurns: number;
  /** Failure signature from the most recent failing turn (for stall detection). */
  lastFailureSignature?: string;
  /** How many consecutive turns have produced the same failure signature. */
  stallCount?: number;
  /** How many redraft resets have been triggered in this session. */
  redraftCount?: number;
  /**
   * True ONLY when the loop exited because the tiered oracle confirmed tests
   * are green (outcome === "solved"). A `status === "done"` run without this
   * flag means the model called finish() but tests were NOT oracle-verified.
   */
  verified?: boolean;
}

export interface Candidate {
  index: number;
  rawResponse: string;
  reasoning?: string;
  answer: string;
  editBlocks: EditBlock[];
  applyResults: ApplyResult[];
  checksRun: number;
  checksPassed: number;
  verifierScore: number; // 0–1, fraction of checks passed
}

export interface BestOfNResult {
  winner: Candidate;
  all: Candidate[];
  n: number;
}

export interface AgentConfig {
  repoRoot: string;
  modelId: string;
  maxTurns: number;
  bestOfN: number;
  statePath?: string; // where to persist AgentState JSON; default: <repoRoot>/.smallcode/state.json
  allowedCommands?: string[]; // allowlist for run_command sandbox
  requireApproval?: boolean; // gate destructive actions behind user approval
  disciplineRules?: boolean; // include Karpathy-style discipline rules in system prompt (default: true)
  preSolveReflection?: boolean; // planner briefly reflects before decomposing goals (default: false)
  promptSet?: PromptSet; // override all three agent prompts (system, planner, reflection); takes precedence over disciplineRules
}
