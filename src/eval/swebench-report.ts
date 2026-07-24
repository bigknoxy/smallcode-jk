/**
 * Honest SWE-bench-Lite report builder (E3-T2). Pure — no I/O — so the reporting
 * contract is unit-tested without cloning a repo or running the agent.
 *
 * The one rule: NEVER invent a pass rate for env-unavailable instances. A pass@1
 * is reported ONLY over the RUNNABLE subset (instances whose tests this machine
 * could actually collect + run), with the skip breakdown always shown, so a
 * number can never overstate coverage or fake a 0.
 */

export interface SwebenchRun {
  total: number;
  runnable: number;
  passed: number;
  editFmt: number;
  /** Runnable passes a harness rescue (not the model) solved. */
  rescued: number;
  /** Per-instance skip strings, each `"<id> (<reason>)"`. */
  skipped: string[];
}

/** Categorize a skip string by its parenthetical reason. Pure. */
export function skipReason(skip: string): string {
  if (/env-unavailable/.test(skip)) return "env-unavailable";
  if (/clone failed/.test(skip)) return "clone-failed";
  if (/checkout failed/.test(skip)) return "checkout-failed";
  if (/test_patch apply failed/.test(skip)) return "patch-failed";
  return "other";
}

/** Build the honest report lines + the skip breakdown from a run's counters. Pure. */
export function summarizeSwebench(r: SwebenchRun): { skipsByReason: Record<string, number>; lines: string[] } {
  const skipsByReason: Record<string, number> = {};
  for (const s of r.skipped) {
    const reason = skipReason(s);
    skipsByReason[reason] = (skipsByReason[reason] ?? 0) + 1;
  }

  const lines: string[] = [];
  lines.push(`[swebench] runnable here: ${r.runnable}/${r.total}  (skipped ${r.skipped.length})`);
  const brk = Object.entries(skipsByReason)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  if (brk) lines.push(`[swebench] skip breakdown: ${brk}`);
  if (r.runnable > 0) {
    lines.push(
      `[swebench] pass@1 (runnable subset): ${(r.passed / r.runnable).toFixed(2)} ` +
        `(${r.passed}/${r.runnable})  edit-format: ${((r.editFmt / r.runnable) * 100).toFixed(0)}%`,
    );
    lines.push(
      `[swebench] how solved: ${r.passed - r.rescued} model-solved, ${r.rescued} harness-rescued ` +
        `(of ${r.passed} passing)`,
    );
  } else {
    lines.push(
      "[swebench] 0 instances runnable on this machine — SWE-bench-Lite needs each instance's pinned Python " +
        "env (the official harness ships a Docker image per instance). No pass-rate reported (honest, never a fake 0).",
    );
  }
  return { skipsByReason, lines };
}
