/**
 * P0#2 phase-gated tool access (statewright mechanism, docs/harness-engineering-
 * roadmap.md item 2). Opt-in A/B experiment behind SMALLCODE_PHASE_GATE — OFF by
 * default, byte-identical to prior behavior when off (see src/config/env.ts).
 *
 * Restricts which tools are advertised/allowed per turn based on whether the
 * model has confidently engaged the edit target yet:
 *
 * - "explore": no confident target (context.targetFile === undefined AND
 *   state.lockedTargetPath === undefined) AND the model has not read any file
 *   yet this run. Only read/inspect tools are available — write_file,
 *   run_command, and FILE:/PATCH: edit blocks are all rejected. This targets
 *   the "sequencing error" statewright's phase gate fixes: a small model
 *   attempting an edit before it has looked at the failing file.
 * - "edit": a target is pinned/locked, OR the model has already read a file
 *   this run. Full tool set — this is CURRENT (pre-feature) behavior.
 *
 * VERIFY (the turn immediately after an applied-but-still-failing edit) was
 * scoped in the roadmap as a third, transient phase, but folded here into
 * "edit": once an edit has been applied the model is by definition past
 * "explore" (it has read/targeted a file), and the *fix* it needs to make
 * requires the same write tools "edit" already grants. Gating verify
 * separately would add a distinct allowed-tools bucket with no behavioral
 * difference from "edit" — a clean negative, documented rather than
 * over-engineered into a real third state.
 *
 * Pure, no I/O — both the prompt (prompt.ts) and the loop's write-rejection
 * (loop.ts) call derivePhase()/PHASE_ALLOWED_TOOLS from here so they can never
 * drift relative to each other.
 */

import type { ContextBundle } from "@/context/types.ts";
import type { AgentState, ToolName } from "./types.ts";

export type Phase = "explore" | "edit";

/** Feedback shown to the model when a write is rejected during "explore". */
export const EXPLORE_REJECT_MESSAGE =
  "Localize first — read the failing file before editing. Tools available now: read_file, run_tests, think.";

/** Tools advertised/permitted per phase. Read-only tools only in "explore". */
export const PHASE_ALLOWED_TOOLS: Record<Phase, ToolName[]> = {
  explore: ["read_file", "run_tests", "think", "finish"],
  edit: ["read_file", "write_file", "run_command", "run_tests", "think", "finish"],
};

/**
 * True once the model has read at least one file this run (a successful
 * `read_file` tool call in any prior turn). Used to move a target-less run out
 * of "explore" once it has actually looked at something, rather than trapping
 * it in "explore" forever when retrieval never confidently pins a target
 * (multi-file / no-clear-target tasks).
 */
function hasReadAnyFile(state: AgentState): boolean {
  return state.turns.some((turn) =>
    turn.toolCalls.some((tc) => tc.name === "read_file") &&
    turn.toolResults.some((tr) => tr.name === "read_file" && tr.success),
  );
}

/**
 * Derive this turn's phase. Pure — no I/O, deterministic given (state, context).
 *
 * A confidently-pinned target (live per-turn `context.targetFile` OR the
 * stable run-level `state.lockedTargetPath`) is ALWAYS "edit", regardless of
 * turn count — this is the common 1-turn-solve path (retrieval already pinned
 * the target on turn 1) and must never be forced through an "explore" turn.
 */
export function derivePhase(state: AgentState, context: ContextBundle): Phase {
  const hasTarget = context.targetFile !== undefined || state.lockedTargetPath !== undefined;
  if (hasTarget) return "edit";
  if (hasReadAnyFile(state)) return "edit";
  return "explore";
}
