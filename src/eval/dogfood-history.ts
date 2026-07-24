/**
 * E3-T3 — dogfood harness over smallcode's OWN git history. Highest-fidelity real
 * test: take a real past bug-fix commit, re-introduce the bug by reverse-applying
 * only its SOURCE hunks (keeping the guarding test the commit added), and have the
 * current smallcode agent re-fix it — graded by smallcode's own `bun test`.
 *
 * This module holds the PURE helpers (file classification + labeling + result
 * summary) so the harness's contract is unit-tested without a git worktree or an
 * agent run. The I/O runner lives in scripts/dogfood-history.ts.
 */

/** Split a commit's changed files into the source to revert vs the tests to keep. */
export function classifyCommitFiles(files: string[]): { src: string[]; test: string[]; other: string[] } {
  const src: string[] = [];
  const test: string[] = [];
  const other: string[] = [];
  for (const f of files) {
    if (/(^|\/)tests?\//.test(f) || /\.test\.ts$/.test(f)) test.push(f);
    else if (/^src\/.+\.ts$/.test(f) || /^bin\/.+\.ts$/.test(f)) src.push(f);
    else other.push(f); // docs, config, README — not part of the dogfood task
  }
  return { src, test, other };
}

/** Single-site (one src file) vs cross-file (multiple). Pure. */
export function labelChange(srcFiles: string[]): "single-site" | "cross-file" {
  return srcFiles.length > 1 ? "cross-file" : "single-site";
}

export interface DogfoodResult {
  commit: string;
  label: "single-site" | "cross-file";
  /** Did re-introducing the bug make the guarding test go red (setup is valid)? */
  bugReproduced: boolean;
  /** Did the agent re-fix it (guarding test green again)? undefined if not run. */
  solved?: boolean;
  /** Was a solve produced by a harness rescue rather than the model? */
  rescued?: boolean;
  /** Non-fatal reason this commit was skipped (revert didn't apply, etc.). */
  skipped?: string;
}

/** Build the honest report lines from dogfood results. Pure; tested. */
export function summarizeDogfood(results: DogfoodResult[]): string[] {
  const lines: string[] = [];
  const usable = results.filter((r) => r.skipped === undefined);
  const withAgent = usable.filter((r) => r.solved !== undefined);
  for (const r of results) {
    if (r.skipped) {
      lines.push(`  SKIP ${r.commit} (${r.label}) — ${r.skipped}`);
    } else if (r.solved === undefined) {
      lines.push(`  SETUP-OK ${r.commit} (${r.label}) — bug reproduced: ${r.bugReproduced ? "yes" : "NO"}`);
    } else {
      const how = r.solved ? (r.rescued ? "solved (harness-rescued)" : "solved (model)") : "NOT solved";
      lines.push(`  ${r.solved ? "PASS" : "fail"} ${r.commit} (${r.label}) — ${how}`);
    }
  }
  if (withAgent.length > 0) {
    const solved = withAgent.filter((r) => r.solved).length;
    const rescued = withAgent.filter((r) => r.solved && r.rescued).length;
    lines.push(
      `[dogfood] solved ${solved}/${withAgent.length} re-introduced bugs ` +
        `(${solved - rescued} model, ${rescued} harness-rescued)`,
    );
  } else if (usable.length > 0) {
    const reproduced = usable.filter((r) => r.bugReproduced).length;
    lines.push(`[dogfood] setup-only: ${reproduced}/${usable.length} commits reproduced the bug (test went red)`);
  }
  return lines;
}
