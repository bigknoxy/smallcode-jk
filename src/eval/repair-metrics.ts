import type { TurnRecord } from "@/agent/types.ts";
import type { RepairResult } from "@/edit/types.ts";

/**
 * Repair-path telemetry over a run's turns.
 *
 * The edit applier already stamps `ApplyResult.repair = { strategy, confidence }`
 * on any SEARCH/REPLACE block that only matched AFTER the fuzzy-repair pipeline
 * salvaged it (the model's search text drifted from the source — whitespace /
 * indent / near-miss). An EXACT match leaves `repair` undefined. So a successful
 * apply carrying `repair` === "the model emitted a slightly-wrong edit that the
 * harness rescued." This function counts how often that happened, which is the
 * measurable payoff ceiling for any edit-FORMAT change (the P2 constrained-
 * decoding spike closed NO-GO precisely because there was no baseline for this
 * rate — see docs/harness-engineering-roadmap.md).
 *
 * Pure — no I/O. Only inspects `turn.applyResults`.
 */
export interface RepairSummary {
  /** Successfully-applied edit blocks (status === "applied"). */
  appliedEdits: number;
  /** Applied edits that needed a non-exact repair strategy to match. */
  repaired: number;
  /** repaired / appliedEdits (0 when no edits applied). */
  repairRate: number;
  /** Count per salvage strategy among the repaired edits. */
  byStrategy: Record<RepairResult["strategy"], number>;
}

export function summarizeRepairs(turns: TurnRecord[]): RepairSummary {
  const byStrategy: Record<RepairResult["strategy"], number> = {
    exact: 0,
    whitespace: 0,
    fuzzy: 0,
    failed: 0,
  };
  let appliedEdits = 0;
  let repaired = 0;

  for (const turn of turns) {
    for (const ar of turn.applyResults) {
      if (ar.status !== "applied") continue;
      appliedEdits++;
      if (ar.repair) {
        repaired++;
        byStrategy[ar.repair.strategy]++;
      }
    }
  }

  return {
    appliedEdits,
    repaired,
    repairRate: appliedEdits === 0 ? 0 : repaired / appliedEdits,
    byStrategy,
  };
}
