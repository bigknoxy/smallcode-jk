import type { AgentState } from "@/agent/types.ts";
import { type TestBaseline, runTieredOracle } from "@/verify/oracle.ts";

/**
 * Pluggable deterministic-repair archetype (E4-T1). The three shipped repairs
 * (operator-mutation, literal-mutation, statement/read-after-delete) shared ~80%
 * of their I/O driver: pick target file(s) → build candidate replacements → for
 * each candidate write it, run the REAL oracle, keep the first fully-green, revert
 * misses, contain any throw so the final-state guard still runs. That identical
 * loop now lives once in {@link runArchetypeRepair}; each archetype supplies only
 * the two things that VARY — which files to touch (`targets`) and the ordered
 * candidate replacements for a file (`candidatesFor`). Adding a new archetype is
 * therefore a small `targets`+`candidatesFor` pair, nothing more.
 *
 * Invariants the driver preserves (unfakeable): a candidate is kept ONLY on a
 * fully-green oracle verdict; every miss reverts the file to exactly how the model
 * left it; a candidate write / oracle throw restores the model's edit and hands
 * off UNSOLVED (never orphans a half-tried candidate on disk).
 */
export interface RepairCandidate {
  /** Full replacement text for the target file. */
  candidate: string;
  /** Human label for attribution (e.g. `"!== -> === (original)"`). */
  label: string;
  /** 1-based line of the change, for telemetry. */
  line: number;
}

export interface RepairArchetype {
  /** Short name used in log lines, e.g. `"mutation-repair"`. */
  logName: string;
  /** The file(s) to attempt, in priority order. Empty = nothing to repair. */
  targets(state: AgentState): string[];
  /**
   * Ordered candidate replacements for ONE target file given its current on-disk
   * content. Encapsulates base selection (pristine / latest-attempt / current),
   * enumeration, scoping, and any per-archetype cap. `attemptsSoFar` (the driver's
   * running candidate count across all targets) lets an archetype share one cap
   * across a multi-file set — return fewer/no candidates when the budget is spent.
   * Empty = nothing to try for this file.
   */
  candidatesFor(state: AgentState, targetPath: string, current: string, attemptsSoFar: number): RepairCandidate[];
}

export interface RepairOutcome {
  file: string;
  label: string;
  line: number;
  attempts: number;
}

/**
 * Shared driver for every repair archetype. Deterministic; can't fake-green
 * (requires a full-green oracle verdict). Returns the winning candidate's
 * attribution, or null when nothing greened / a candidate threw.
 */
export async function runArchetypeRepair(
  archetype: RepairArchetype,
  state: AgentState,
  testBaseline: TestBaseline,
  readFileFn: (p: string) => Promise<string | null>,
  writeFileFn: (p: string, content: string) => Promise<void>,
  // Injectable oracle (defaults to the real tiered oracle) — lets tests simulate
  // a `bun test` timeout mid-repair without a global module mock.
  runOracle: typeof runTieredOracle = runTieredOracle,
): Promise<RepairOutcome | null> {
  let attempts = 0;
  for (const targetRel of archetype.targets(state)) {
    const current = await readFileFn(targetRel);
    if (current === null) continue;
    const candidates = archetype.candidatesFor(state, targetRel, current, attempts);
    if (candidates.length === 0) continue;
    try {
      for (const c of candidates) {
        attempts++;
        await writeFileFn(targetRel, c.candidate);
        const verdict = await runOracle(state.repoRoot, { baseline: testBaseline });
        if (verdict.outcome === "solved") {
          // Leave the winning candidate on disk — it IS the fix.
          return { file: targetRel, label: c.label, line: c.line, attempts };
        }
        // Miss: restore the file to exactly how the model left it before the next.
        await writeFileFn(targetRel, current);
      }
    } catch (err) {
      // A candidate write / oracle run threw mid-loop (e.g. a `bun test` timeout).
      // Restore the model's edit so we never orphan a half-tried candidate on disk,
      // then hand off UNSOLVED — the final-state guard is the backstop.
      try {
        await writeFileFn(targetRel, current);
      } catch {
        // best-effort restore
      }
      console.error(
        `[${archetype.logName}] ${targetRel}: aborted after ${attempts} candidate(s) — ` +
          `${err instanceof Error ? err.message : String(err)}; restored the model's edit.`,
      );
      return null;
    }
  }
  return null;
}
