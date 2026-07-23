import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Write-ahead apply journal — crash recovery for the edit-apply pipeline.
 *
 * The agent writes edits file-by-file (`applyBatch` and the `write_file` tool).
 * If the process is killed / OOMs / the model backend disconnects AFTER file 1
 * is written but BEFORE file 2, the per-turn revert and the final-state guard
 * never run (they execute later in the same process), so nothing rolls the
 * half-written repo back — it is left strictly worse with no in-process signal.
 *
 * This journal closes that gap by persisting, OUTSIDE the repo, the pre-run
 * content of every file the run is about to touch, BEFORE the first write. On
 * the NEXT invocation, a surviving `in-progress` journal means the previous run
 * never reached a clean terminal state (guard + markClean), so we REPLAY it:
 * restore each recorded original and delete files the crashed run created,
 * returning the working tree to exactly its pre-run state. A clean run deletes
 * its journal, so recovery is a no-op. Net effect: apply is atomic at
 * run-granularity across a crash.
 *
 * Storage is keyed by a hash of the absolute repo root under
 * `os.tmpdir()/smallcode-journal/`, so it (a) survives even when the repo dir is
 * what's being written, and (b) is per-repo — eval trials in distinct throwaway
 * dirs never collide or leak recovery into one another.
 *
 * SINGLE-WRITER assumption: the journal is one file per repo with no lock, so it
 * assumes ONE `smallcode` process operates on a given repo checkout at a time —
 * the normal local-tool usage. Two concurrent runs on the SAME repo dir (e.g. a
 * background `run` plus an interactive `chat`, or two eval workers mis-pointed at
 * one dir) would have the second run's `beginRun`/`recoverIfNeeded` clobber or
 * replay the first's in-progress journal. Eval is safe because each trial gets a
 * distinct throwaway dir (a distinct journal). For genuinely concurrent work on
 * one repo, use separate worktrees (distinct repoRoots → distinct journals).
 */

export interface JournalFileEntry {
  /** Path exactly as handed to the write layer (repo-relative). */
  path: string;
  /** True if the file existed on disk before the run's first write to it. */
  existed: boolean;
  /** Pre-run content when `existed`; null for files the run created. */
  originalContent: string | null;
}

export interface Journal {
  version: 1;
  runId: string;
  /** Absolute repo root the entries' paths resolve against. */
  repoRoot: string;
  status: "in-progress" | "clean";
  /** ISO timestamp; supplied by the caller (the module never reads the clock). */
  startedAt: string;
  entries: JournalFileEntry[];
}

const JOURNAL_DIR = join(tmpdir(), "smallcode-journal");

/** Absolute path of the journal file for a given repo root. Exported for tests. */
export function journalPathFor(repoRoot: string): string {
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  return join(JOURNAL_DIR, `${hash}.json`);
}

async function readJournal(repoRoot: string): Promise<Journal | null> {
  try {
    const raw = await readFile(journalPathFor(repoRoot), "utf-8");
    const j = JSON.parse(raw) as Journal;
    // Defensive: a corrupt/foreign file is treated as "no journal" rather than
    // throwing — recovery must never crash the run it is trying to protect.
    if (j && j.version === 1 && Array.isArray(j.entries)) return j;
    return null;
  } catch {
    return null;
  }
}

async function writeJournal(j: Journal): Promise<void> {
  await mkdir(JOURNAL_DIR, { recursive: true });
  await writeFile(journalPathFor(j.repoRoot), JSON.stringify(j), "utf-8");
}

/**
 * Start a fresh journal for a run (status `in-progress`, no entries). Overwrites
 * any prior journal for this repo — callers MUST run {@link recoverIfNeeded}
 * first so a genuinely-stale journal is replayed, not clobbered.
 */
export async function beginRun(repoRoot: string, runId: string, startedAt: string): Promise<void> {
  await writeJournal({ version: 1, runId, repoRoot, status: "in-progress", startedAt, entries: [] });
}

/**
 * Record the pre-run state of files the run is ABOUT to write — call this
 * BEFORE the write. First-seen wins per path (later turns editing the same file
 * must not overwrite its true pre-run content), mirroring `pristineRunSnapshot`.
 * `capture` yields each planned file's current on-disk content (null ⇒ the file
 * does not exist yet, i.e. the run will create it). No-op when no journal exists
 * (feature disabled / already cleaned).
 */
export async function recordOriginals(
  repoRoot: string,
  paths: string[],
  capture: (p: string) => Promise<string | null>,
): Promise<void> {
  const j = await readJournal(repoRoot);
  if (j === null || j.status !== "in-progress") return;
  const seen = new Set(j.entries.map((e) => e.path));
  let changed = false;
  for (const p of paths) {
    if (seen.has(p)) continue;
    const original = await capture(p);
    j.entries.push({ path: p, existed: original !== null, originalContent: original });
    seen.add(p);
    changed = true;
  }
  if (changed) await writeJournal(j);
}

/**
 * Mark the run cleanly finished: the apply + oracle + guard sequence completed
 * in-process, so whatever is on disk is intentional and needs no recovery. We
 * delete the journal (a clean run leaves none behind). Idempotent.
 */
export async function markClean(repoRoot: string): Promise<void> {
  await rm(journalPathFor(repoRoot), { force: true });
}

export interface RecoveryResult {
  recovered: boolean;
  /** Files restored to their pre-run content. */
  restored: string[];
  /** Files the crashed run created that were deleted. */
  deleted: string[];
  /** Entries whose restore/delete threw — recovery is best-effort, never fatal. */
  failed: string[];
}

/**
 * At run start: if an `in-progress` journal survives for this repo, the previous
 * run died before reaching a clean terminal state. Replay it — restore every
 * recorded original and delete every file the crashed run created — then remove
 * the journal so the fresh run starts clean. A missing or `clean` journal is a
 * no-op. `writeFileFn`/`rmFn` are injected so recovery reuses the loop's
 * path-safe write/delete (and so tests can drive it deterministically).
 */
export async function recoverIfNeeded(
  repoRoot: string,
  writeFileFn: (p: string, content: string) => Promise<void>,
  rmFn: (p: string) => Promise<void>,
): Promise<RecoveryResult> {
  const j = await readJournal(repoRoot);
  if (j === null || j.status !== "in-progress")
    return { recovered: false, restored: [], deleted: [], failed: [] };

  const restored: string[] = [];
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const e of j.entries) {
    // Best-effort per entry: a single unrestorable file must not abort recovery
    // of the rest, nor throw out of the run it is protecting. Failures are
    // collected so the caller can warn (fail-closed) rather than crash.
    try {
      if (e.existed && e.originalContent !== null) {
        await writeFileFn(e.path, e.originalContent);
        restored.push(e.path);
      } else {
        await rmFn(e.path);
        deleted.push(e.path);
      }
    } catch {
      failed.push(e.path);
    }
  }
  await markClean(repoRoot);
  return { recovered: restored.length + deleted.length > 0, restored, deleted, failed };
}

/** Resolve a repo-relative path inside `repoRoot`, rejecting traversal. */
function resolveInRepo(repoRoot: string, p: string): string | null {
  const abs = resolve(repoRoot, p);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/**
 * Self-contained recovery for callers that don't build the loop's path-safe
 * write/rm (e.g. the `smallcode chat` REPL reconciling a task whose `runLoop`
 * threw). Builds default path-safe write/delete relative to `repoRoot` and
 * replays a surviving in-progress journal. No-op when none exists.
 */
export async function recoverRepo(repoRoot: string): Promise<RecoveryResult> {
  const write = async (p: string, content: string): Promise<void> => {
    const abs = resolveInRepo(repoRoot, p);
    if (abs === null) throw new Error(`journal recovery: path traversal rejected: ${p}`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  };
  const remove = async (p: string): Promise<void> => {
    const abs = resolveInRepo(repoRoot, p);
    if (abs !== null) await rm(abs, { force: true });
  };
  return recoverIfNeeded(repoRoot, write, remove);
}

/** True when an `in-progress` journal exists for this repo. Exported for tests/diag. */
export async function hasPendingJournal(repoRoot: string): Promise<boolean> {
  // readJournal already returns null for a missing/corrupt file, so it doubles
  // as the existence check — no separate stat needed.
  const j = await readJournal(repoRoot);
  return j !== null && j.status === "in-progress";
}
