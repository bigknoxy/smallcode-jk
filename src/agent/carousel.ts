import type { AgentState } from "./types.ts";

/**
 * Set-carousel (SMALLCODE_SET_CAROUSEL). Pure state-transition helper for
 * decomposing one hard cross-file localization into a sequence of single-file
 * ones: advance `state.carouselIndex` to the next file in `editablePaths`
 * (wrapping), record it as `carouselFocus` (surfaced by prompt.ts's "## FOCUS
 * THIS TURN" block), and give the new focus a fresh stall + redraft budget.
 *
 * The call site (loop.ts) gates invocation on the model having stalled
 * (`stallCount >= STALL_LIMIT`) — fires on stall ALONE, not gated on exhausting
 * the redraft budget first, so it triggers well within a bounded eval's turn
 * budget instead of waiting out a useless same-file redraft cycle first. `opts`
 * is accepted for parity with the call site's thresholds but the advance
 * decision itself is the caller's; this helper only enforces the structural
 * preconditions below.
 *
 * Attention-only: this NEVER touches `lockedTargetPath`, `editablePaths` itself,
 * or any enforcement/oracle/revert state — every member of `editablePaths` stays
 * editable throughout, exactly as SMALLCODE_TARGET_SET already allows. It only
 * decides which file the PROMPT tells the model to focus on next.
 *
 * Bounded by a safety cap of `editablePaths.length * 2` (at most two full sweeps
 * of the set) via `state.carouselCount`, so a run that never solves does not
 * carousel forever. No-op when `editablePaths.length <= 1` (nothing to advance
 * to) or when the sweep cap has been reached.
 *
 * Mutates `state` in place; returns void. Pure aside from that mutation — no I/O.
 */
export function advanceCarousel(
  state: AgentState,
  editablePaths: string[],
  _opts: { stallLimit: number; maxRedrafts: number },
): void {
  if (editablePaths.length <= 1) return;

  const cap = editablePaths.length * 2; // safety: at most 2 full sweeps
  if ((state.carouselCount ?? 0) >= cap) return;

  state.carouselIndex = ((state.carouselIndex ?? 0) + 1) % editablePaths.length;
  state.carouselFocus = editablePaths[state.carouselIndex];
  state.carouselCount = (state.carouselCount ?? 0) + 1;

  // Give the NEW focus its own fresh stall + redraft budget.
  state.stallCount = 0;
  state.lastFailureSignature = undefined;
  state.redraftCount = 0;
}
