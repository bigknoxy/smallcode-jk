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
  /** SMALLCODE_RAD_HINT: set when this failing turn left a read-after-delete
   *  ordering bug on the locked target. The next prompt surfaces `hint` so the
   *  MODEL reorders it. Purely a prompt signal — NOT a harness rescue, so passes
   *  stay attributed to the model in pass-quality classification. */
  readAfterDelete?: { object: string; key: string; line: number; hint: string };
  /**
   * Set on the synthetic turn recorded when harness-side operator-mutation repair
   * (SMALLCODE_MUTATION_REPAIR) solved the task after the model loop failed. Names
   * the winning single-operator flip, its line, and how many candidates were tried
   * before it went green — so the solve is attributable to the harness, not the
   * model, in transcripts and pass-quality classification.
   */
  mutationRepair?: { label: string; line: number; attempts: number };
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
  /**
   * Target-lock (fix #80 follow-up): the FIRST confidently-pinned edit target
   * (`context.targetFile.path`) seen this run, captured ONCE and never
   * overwritten. Per-turn retrieval (`getContext`) re-runs every turn and its
   * `targetFile` DRIFTS once the model edits an off-target file (that file
   * enters recent-history/context and gets re-pinned) — enforcing against the
   * live per-turn value let a drifted edit "become" the new target and stop
   * being rejected. Enforcement in loop.ts uses THIS stable field instead, so
   * drift can never move the lock. Unset when no confident target was ever
   * established (multi-file tasks stay unlocked, as before).
   */
  lockedTargetPath?: string;
  /**
   * Retarget tracking (mis-pin self-correction follow-up): the CURRENT
   * consecutive streak of REJECTED off-target edit attempts, keyed to a
   * single path. When the model keeps attempting the SAME non-locked source
   * file turn after turn, that's usually a sign retrieval pinned the WRONG
   * file — the model is (correctly) trying to fix the real target and the
   * lock is blocking it forever. `count` reaching `OFF_TARGET_RETARGET_THRESHOLD`
   * (loop.ts) retargets `lockedTargetPath` to `path` instead of rejecting
   * again. Reset to undefined whenever the model targets the (current)
   * locked file, or replaced with a fresh `{ path, count: 1 }` when it
   * attempts a DIFFERENT off-target file — only a persistent single-file
   * streak can retarget, so genuine random drift (a different off-target
   * file each turn) keeps getting rejected forever, same as before.
   */
  offTargetStreak?: { path: string; count: number };
  /**
   * Final-state guard (SMALLCODE_FINAL_STATE_GUARD): set when the run ended
   * UNSOLVED and the end-of-run disk state was STRICTLY WORSE than the run-start
   * baseline, so every file the agent touched was reverted to pristine (and any
   * brand-new files it created were deleted) to honor the "never leave the repo
   * worse than found" guarantee. `newFailures` lists the tests that had
   * regressed; `startRed`/`endRed` are the baseline vs pre-revert red counts.
   * Absent on solved runs and on unsolved-but-not-worse runs (partial progress
   * is kept).
   */
  finalStateReverted?: { newFailures: string[]; startRed: number; endRed: number; filesRestored: number };
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
