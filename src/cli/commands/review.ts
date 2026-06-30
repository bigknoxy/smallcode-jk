import { resolve } from "node:path";
import type { EditBlock } from "../../edit/types.ts";
import type { ParsedArgs } from "../args.ts";

/**
 * Diff-review-before-write approver (R9). Returns an `approveEdit` hook for the
 * loop when `requireApproval` is on: it prints the proposed edit blocks (path +
 * format + a truncated preview of the new content) and reads a y/N from the
 * terminal — default N, so the user must opt IN to each write. Returns undefined
 * when approval isn't required → the loop applies edits unconditionally.
 */
export function makeInteractiveApprover(
  requireApproval: boolean | undefined,
): ((blocks: EditBlock[]) => Promise<boolean>) | undefined {
  if (!requireApproval) return undefined;
  return (blocks: EditBlock[]) => {
    process.stderr.write(`\n[smallcode] Review ${blocks.length} proposed edit(s) before writing:\n`);
    for (const b of blocks) {
      const whole = b.search === "";
      process.stderr.write(`  ── ${b.filePath} [${b.format}${whole ? ", full file" : ""}]\n`);
      const lines = b.replace.split("\n");
      process.stderr.write(`${lines.slice(0, 24).map((l) => `   | ${l}`).join("\n")}\n`);
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

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  const out =
    (p.stdout instanceof Uint8Array ? new TextDecoder().decode(p.stdout) : "") +
    (p.stderr instanceof Uint8Array ? new TextDecoder().decode(p.stderr) : "");
  return { ok: (p.exitCode ?? 1) === 0, out };
}

function isGitRepo(repo: string): boolean {
  return git(["rev-parse", "--git-dir"], repo).ok;
}

/** Working-tree changes: tracked diff stat + untracked files the agent created. */
export function workingChanges(repo: string): { stat: string; untracked: string[]; hasChanges: boolean } {
  const stat = git(["diff", "--stat"], repo).out.trim();
  const untracked = git(["ls-files", "--others", "--exclude-standard"], repo)
    .out.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { stat, untracked, hasChanges: stat.length > 0 || untracked.length > 0 };
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
 * `smallcode undo` — revert the agent's working-tree changes. DESTRUCTIVE, so it
 * is DRY-RUN by default (prints what it would do); pass --yes to actually revert.
 * Restores tracked files (`git restore`) and deletes untracked files the agent
 * created (`git clean -fd`). Never touches committed history.
 */
export async function undoCommand(args: ParsedArgs): Promise<void> {
  const repo = resolve(flagString(args.flags, "repo") ?? process.cwd());
  if (!isGitRepo(repo)) {
    process.stderr.write(`[smallcode] ${repo} is not a git repository — cannot undo.\n`);
    process.exit(1);
  }
  const { stat, untracked, hasChanges } = workingChanges(repo);
  if (!hasChanges) {
    process.stdout.write("[smallcode] Nothing to undo — working tree is clean.\n");
    return;
  }

  if (!flagBool(args.flags, "yes")) {
    process.stdout.write(
      "[smallcode] undo (dry-run) — this would DISCARD the following working-tree changes:\n\n" +
        (stat ? `${stat}\n` : "") +
        (untracked.length ? `\nUntracked files to delete:\n  ${untracked.join("\n  ")}\n` : "") +
        "\nRe-run with --yes to apply. (Restores tracked files + deletes the agent's new files; committed history is untouched.)\n",
    );
    return;
  }

  const restore = git(["restore", "--", "."], repo);
  const clean = git(["clean", "-fd"], repo);
  if (!restore.ok || !clean.ok) {
    process.stderr.write(`[smallcode] undo failed: ${(restore.out + clean.out).trim()}\n`);
    process.exit(1);
  }
  process.stdout.write("[smallcode] ✓ Reverted the agent's changes — working tree restored.\n");
}
