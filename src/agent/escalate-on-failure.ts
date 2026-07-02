import type { AgentState } from "./types.ts";

/**
 * R1 single-shot escalate-on-failure.
 *
 * Runs the cheapest model in the ladder as a normal single-shot attempt; if the
 * oracle does NOT confirm the fix, reverts that attempt's edits and retries with
 * the next (bigger) LOCAL model, stopping on the first solved attempt or when the
 * ladder is exhausted. This is the sibling of the Best-of-N escalation ladder
 * (`escalation.ts` + `runBestOfNLoop`), but for the common `bestOfN === 1` path:
 * it does NOT require a clean git tree — the caller's `reset` reverts ONLY the
 * agent's own edits (scoped manifest undo), so the user's uncommitted work is
 * preserved and each rung starts from the same pre-run state.
 *
 * Pure control-flow: all I/O (running the loop, checking the oracle, reverting)
 * is injected, so this is unit-tested with mocks and never touches disk itself.
 *
 * `reset` runs BEFORE attempts 2..n (never before the first, never after the
 * last) — so a solved attempt's edits are kept, and if every rung fails the LAST
 * (biggest) model's attempt is what remains on disk for the user to inspect.
 */
export interface EscalateOnFailureDeps {
  /** Ordered model ids, cheapest first. Must be non-empty. */
  models: string[];
  /** Run one single-shot attempt with the given model; returns its final state. */
  runAttempt: (modelId: string, attempt: number) => Promise<AgentState>;
  /** True when the attempt's state is an oracle-confirmed solve. */
  isSolved: (state: AgentState) => Promise<boolean> | boolean;
  /** Revert the prior (failed) attempt's edits before the next rung runs. */
  reset: () => Promise<void> | void;
  /** Optional progress sink (one line per escalation step). */
  log?: (msg: string) => void;
}

export interface EscalateResult {
  finalState: AgentState;
  /** The model that produced the solved state, or undefined if none did. */
  solvedModelId?: string;
  /** How many rungs actually ran (1-based). */
  attemptsUsed: number;
}

export async function runEscalateOnFailure(deps: EscalateOnFailureDeps): Promise<EscalateResult> {
  const { models, runAttempt, isSolved, reset, log } = deps;
  if (models.length === 0) {
    throw new Error("runEscalateOnFailure: models ladder must be non-empty");
  }

  let last: AgentState | undefined;
  for (let i = 0; i < models.length; i++) {
    const modelId = models[i]!;
    if (i > 0) {
      log?.(
        `escalating to ${modelId} (attempt ${i + 1}/${models.length}) — previous model did not solve it`,
      );
      await reset();
    }
    const state = await runAttempt(modelId, i + 1);
    last = state;
    if (await isSolved(state)) {
      return { finalState: state, solvedModelId: modelId, attemptsUsed: i + 1 };
    }
  }
  // `last` is defined because models is non-empty and every iteration assigns it.
  return { finalState: last as AgentState, attemptsUsed: models.length };
}
