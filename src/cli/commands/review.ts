import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { git, isGitRepo } from "@/util/git.ts";
import type { EditBlock } from "../../edit/types.ts";
import type { ParsedArgs } from "../args.ts";

/**
 * Diff-review-before-write approver (R9). Returns an `approveEdit` hook for the
 * loop when `requireApproval` is on: it prints the proposed edit blocks (path +
 * format + a truncated preview of the new content) and reads a y/N from the
 * terminal — default N, so the user must opt IN to each write. Returns undefined
 * when approval isn't required → the loop applies edits unconditionally.
 *
 * Two bypasses return `undefined` (apply unconditionally) so the interactive
 * y/N gate never silently auto-declines when it structurally cannot be answered
 * (issue #91 — headless runs with `requireApproval:true` rejected EVERY edit
 * because `prompt()` returns null with no TTY, defaulting the answer to N):
 *   - `opts.bypass` (an explicit `--yes`): the user opted out of review.
 *   - `opts.interactive === false` (no TTY — CI, piped, `--json`, delegation):
 *     an interactive gate can't function, so we apply and emit a ONE-TIME notice
 *     pointing at `smallcode diff`/`undo` (the scoped-undo safety net) rather
 *     than declining every write for reasons unrelated to the edits.
 * `opts` omitted ⇒ `interactive` defaults to true (unchanged behavior for any
 * existing caller that doesn't pass it).
 */
export interface ApproverOptions {
  /** True when stdin is an interactive TTY. Default (omitted) = true. */
  interactive?: boolean;
  /** Explicit bypass (e.g. `--yes`) — apply without prompting. */
  bypass?: boolean;
}

export function makeInteractiveApprover(
  requireApproval: boolean | undefined,
  opts?: ApproverOptions,
): ((blocks: EditBlock[]) => Promise<boolean>) | undefined {
  if (!requireApproval) return undefined;
  if (opts?.bypass) return undefined;
  if (opts?.interactive === false) {
    process.stderr.write(
      "[smallcode] requireApproval is on but stdin is not a TTY — applying edits UNREVIEWED " +
        "(an interactive prompt can't be answered here). Review with `smallcode diff` and roll back " +
        "with `smallcode undo`; pass --yes to silence this notice.\n",
    );
    return undefined;
  }
  return (blocks: EditBlock[]) => {
    process.stderr.write(
      `\n[smallcode] Review ${blocks.length} proposed edit(s) before writing:\n`,
    );
    for (const b of blocks) {
      const whole = b.search === "";
      process.stderr.write(`  ── ${b.filePath} [${b.format}${whole ? ", full file" : ""}]\n`);
      const lines = b.replace.split("\n");
      process.stderr.write(
        `${lines
          .slice(0, 24)
          .map((l) => `   | ${l}`)
          .join("\n")}\n`,
      );
      if (lines.length > 24) process.stderr.write(`   | …(${lines.length - 24} more lines)\n`);
    }
    const ans = (prompt("[smallcode] Apply this edit? [y/N] ") ?? "").trim();
    return Promise.resolve(/^y(es)?$/i.test(ans));
  };
}

// R9 dev-UX: review + undo what the agent did. `smallcode run` edits files in
// place; these give the user the "see what changed / take it back" loop that turns
// a black-box editor into a safe tool. Git-based — the agent's changes are just
// working-tree modifications, so `git diff` shows them and `git restore` + a clean
// of untracked files undoes them.

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}
function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

/** Working-tree changes: tracked diff stat + untracked files the agent created. */
export function workingChanges(repo: string): {
  stat: string;
  untracked: string[];
  hasChanges: boolean;
} {
  const stat = git(["diff", "--stat"], repo).out.trim();
  const untracked = git(["ls-files", "--others", "--exclude-standard"], repo)
    .out.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { stat, untracked, hasChanges: stat.length > 0 || untracked.length > 0 };
}

/**
 * Machine-readable working-tree change summary for `--json` output (run.ts).
 * Parses `git diff --numstat` (tab-separated `added\tremoved\tpath`; binary files
 * report `-` for both counts, which we treat as 0) and folds in untracked
 * (agent-created) files as zero-line-count entries.
 */
export function numstatChanges(repo: string): {
  filesChanged: string[];
  added: number;
  removed: number;
} {
  const numstat = git(["diff", "--numstat"], repo).out;
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of numstat.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [a, r, ...pathParts] = trimmed.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    files.push(path);
    added += a === "-" ? 0 : Number(a) || 0;
    removed += r === "-" ? 0 : Number(r) || 0;
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"], repo)
    .out.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const filesChanged = [...new Set([...files, ...untracked])];
  return { filesChanged, added, removed };
}

// --- Agent-change manifest -------------------------------------------------
// `undo` must NOT blanket-`git restore .`/`git clean -fd` — that would discard the
// USER's own uncommitted edits + untracked files, not just the agent's. So a run
// records exactly which paths IT changed (relative to the pre-run dirty set) into
// .smallcode/agent-changes.json, and undo reverts only those.

interface AgentManifest {
  tracked: string[]; // tracked files the agent modified → git restore
  untracked: string[]; // files the agent created → delete
}

function manifestPath(repo: string): string {
  return `${repo}/.smallcode/agent-changes.json`;
}

function gitLines(args: string[], repo: string): string[] {
  return git(args, repo)
    .out.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** {tracked modified, untracked} sets right now. */
export function changedSets(repo: string): { tracked: Set<string>; untracked: Set<string> } {
  return {
    tracked: new Set(gitLines(["diff", "--name-only"], repo)),
    untracked: new Set(gitLines(["ls-files", "--others", "--exclude-standard"], repo)),
  };
}

/**
 * After a run, record the paths the agent changed = current dirty set MINUS the
 * `before` snapshot (so a file the USER had already dirtied is never claimed).
 * Merges with any existing manifest so a multi-task chat session accumulates.
 */
export async function recordAgentChanges(
  repo: string,
  before: { tracked: Set<string>; untracked: Set<string> },
): Promise<void> {
  const now = changedSets(repo);
  const newTracked = [...now.tracked].filter((p) => !before.tracked.has(p));
  const newUntracked = [...now.untracked].filter((p) => !before.untracked.has(p));
  let prev: AgentManifest = { tracked: [], untracked: [] };
  try {
    prev = JSON.parse(await Bun.file(manifestPath(repo)).text());
  } catch {
    // no prior manifest
  }
  const merged: AgentManifest = {
    tracked: [...new Set([...prev.tracked, ...newTracked])],
    untracked: [...new Set([...prev.untracked, ...newUntracked])],
  };
  await Bun.write(manifestPath(repo), JSON.stringify(merged));
}

export function readManifest(repo: string): AgentManifest | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath(repo), "utf-8")) as AgentManifest;
    if ((m.tracked?.length ?? 0) + (m.untracked?.length ?? 0) === 0) return null;
    return m;
  } catch {
    return null;
  }
}

/** Revert ONLY the agent's recorded paths. Returns what it reverted, or null. */
export function revertAgentChanges(repo: string): AgentManifest | null {
  const m = readManifest(repo);
  if (!m) return null;
  if (m.tracked.length > 0) git(["restore", "--", ...m.tracked], repo);
  for (const p of m.untracked) {
    try {
      rmSync(`${repo}/${p}`, { force: true });
    } catch {
      // best-effort
    }
  }
  try {
    rmSync(manifestPath(repo), { force: true });
  } catch {
    // manifest already gone
  }
  return m;
}

/** `smallcode diff` — show the unified diff of what the agent changed. */
export async function diffCommand(args: ParsedArgs): Promise<void> {
  const repo = resolve(flagString(args.flags, "repo") ?? process.cwd());
  if (!isGitRepo(repo)) {
    process.stderr.write(`[smallcode] ${repo} is not a git repository — nothing to diff.\n`);
    process.exit(1);
  }
  const { untracked, hasChanges } = workingChanges(repo);
  if (!hasChanges) {
    process.stdout.write("[smallcode] No changes in the working tree.\n");
    return;
  }
  process.stdout.write(git(["diff"], repo).out);
  if (untracked.length > 0) {
    process.stdout.write(`\n[smallcode] New (untracked) files:\n  ${untracked.join("\n  ")}\n`);
  }
}

/**
 * `smallcode undo` — revert ONLY the files a smallcode run recorded as its own
 * (the `.smallcode/agent-changes.json` manifest), so the user's own uncommitted
 * edits + untracked files are NEVER touched. DRY-RUN by default; --yes applies.
 * Restores the agent's tracked edits + deletes the agent's new files; committed
 * history is untouched.
 */
export async function undoCommand(args: ParsedArgs): Promise<void> {
  const repo = resolve(flagString(args.flags, "repo") ?? process.cwd());
  if (!isGitRepo(repo)) {
    process.stderr.write(`[smallcode] ${repo} is not a git repository — cannot undo.\n`);
    process.exit(1);
  }
  const m = readManifest(repo);
  if (!m) {
    process.stdout.write(
      "[smallcode] Nothing recorded to undo — no smallcode run changed files in this repo.\n" +
        "(undo only reverts what a smallcode run wrote; use git to review/revert anything else.)\n",
    );
    return;
  }

  if (!flagBool(args.flags, "yes")) {
    process.stdout.write(
      "[smallcode] undo (dry-run) — would revert ONLY these agent-changed paths (your own edits are left alone):\n" +
        (m.tracked.length ? `\nRestore (agent-modified):\n  ${m.tracked.join("\n  ")}\n` : "") +
        (m.untracked.length ? `\nDelete (agent-created):\n  ${m.untracked.join("\n  ")}\n` : "") +
        "\nRe-run with --yes to apply. Committed history is untouched.\n",
    );
    return;
  }

  const reverted = revertAgentChanges(repo);
  if (!reverted) {
    process.stdout.write("[smallcode] Nothing to undo.\n");
    return;
  }
  process.stdout.write(
    `[smallcode] ✓ Reverted ${reverted.tracked.length} agent edit(s) + removed ${reverted.untracked.length} agent file(s). Your own changes untouched.\n`,
  );
}
