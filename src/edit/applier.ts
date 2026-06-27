import { applyPatchBlock } from "./patch-function.ts";
import { repairBlock } from "./repair.ts";
import type { ApplyBatchResult, ApplyResult, EditBlock } from "./types.ts";

/** Sentinel prefix stored in EditBlock.search for patch-function blocks. */
const PATCH_SENTINEL = "\x00PATCH\x00";

// ---------------------------------------------------------------------------
// Whole-file integrity guard
// ---------------------------------------------------------------------------

/** Count delimiter balance — returns true when (), {}, and [] are all net-zero. */
function delimitersBalanced(s: string): boolean {
  const pairs: Array<[string, string]> = [
    ["(", ")"],
    ["{", "}"],
    ["[", "]"],
  ];
  for (const [open, close] of pairs) {
    let depth = 0;
    for (const ch of s) {
      if (ch === open) depth++;
      else if (ch === close) depth--;
      if (depth < 0) return false; // close before open
    }
    if (depth !== 0) return false;
  }
  return true;
}

/**
 * Returns a human-readable reason when a whole-file replacement looks TRUNCATED
 * (a small model that was told to re-emit the entire file dropped the tail), or
 * null when the write looks intact. Conservative by design: it only fires on
 * strong signals so legitimate refactors pass, because the cost of a false
 * accept (writing corruption that regresses passing tests) is far worse than a
 * false reject (one extra re-prompt turn).
 *
 * New/empty files are always allowed. Two signals trigger a reject:
 *  - the replacement's brackets are unbalanced while the original's were
 *    balanced (the classic "cut off mid-function" shape), or
 *  - the replacement lost more than half the lines of a non-trivial file.
 */
export function truncationReason(original: string, replace: string): string | null {
  // New file or previously-empty file: nothing to truncate against.
  if (original.trim() === "") return null;

  if (replace.trim() === "") {
    return "replacement is empty (refusing to blank an existing file)";
  }

  // Bracket-balance: only fire when the ORIGINAL was cleanly balanced (so we
  // don't trip over braces inside strings/regex that exist in both versions).
  if (delimitersBalanced(original) && !delimitersBalanced(replace)) {
    return "unbalanced brackets/braces — output looks cut off mid-file";
  }

  // Drastic shrink on a non-trivial file. >50% line loss from a 3B re-emit is
  // far more likely a dropped tail than an intentional halving.
  const origLines = original.split("\n").length;
  const repLines = replace.split("\n").length;
  if (origLines >= 12 && repLines < origLines * 0.5) {
    return `output is ${repLines} lines vs ${origLines} original (>50% shrink — likely truncated)`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Diff generation
// ---------------------------------------------------------------------------

/** Compute longest-common-subsequence indices (LCS on lines). */
function lcs(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;

  // Use the standard DP table but only keep two rows to save memory.
  // We need the full table to reconstruct, so store it.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  const cell = (r: number, c: number): number => dp[r]?.[c] ?? 0;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? cell(i - 1, j - 1) + 1 : Math.max(cell(i - 1, j), cell(i, j - 1));
    }
  }

  // Backtrack to get matching pairs
  const result: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (cell(i - 1, j) >= cell(i, j - 1)) {
      i--;
    } else {
      j--;
    }
  }
  result.reverse();
  return result;
}

type EditOp =
  | { type: "equal"; aIdx: number; bIdx: number }
  | { type: "remove"; aIdx: number }
  | { type: "insert"; bIdx: number };

function diffLines(a: string[], b: string[]): EditOp[] {
  const common = lcs(a, b);
  const ops: EditOp[] = [];

  let ai = 0;
  let bi = 0;
  for (const [ca, cb] of common) {
    while (ai < ca) {
      ops.push({ type: "remove", aIdx: ai });
      ai++;
    }
    while (bi < cb) {
      ops.push({ type: "insert", bIdx: bi });
      bi++;
    }
    ops.push({ type: "equal", aIdx: ai, bIdx: bi });
    ai++;
    bi++;
  }
  while (ai < a.length) {
    ops.push({ type: "remove", aIdx: ai });
    ai++;
  }
  while (bi < b.length) {
    ops.push({ type: "insert", bIdx: bi });
    bi++;
  }
  return ops;
}

interface Hunk {
  aStart: number; // 0-based
  bStart: number; // 0-based
  lines: string[]; // lines with leading ' ', '-', or '+'
}

const CONTEXT = 3;
const MERGE_THRESHOLD = 6; // merge if gap ≤ this many equal lines

export function generateDiff(original: string, modified: string, filePath: string): string {
  if (original === modified) return "";

  const aLines = original === "" ? [] : original.split("\n");
  const bLines = modified === "" ? [] : modified.split("\n");

  // Remove trailing empty string from split if content ends with \n
  // We keep them to preserve fidelity — split is fine as-is for line diff.

  const ops = diffLines(aLines, bLines);

  if (ops.length === 0) return "";

  // Group ops into hunks with context
  // First pass: find changed regions
  type Region = { start: number; end: number }; // indices into ops[]
  const changedIndices: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]?.type !== "equal") changedIndices.push(k);
  }
  if (changedIndices.length === 0) return "";

  // Build hunk windows: for each changed index, expand ± CONTEXT ops
  // then merge overlapping/adjacent windows
  const windows: Region[] = [];
  for (const ci of changedIndices) {
    const s = Math.max(0, ci - CONTEXT);
    const e = Math.min(ops.length - 1, ci + CONTEXT);
    const last = windows[windows.length - 1];
    if (last !== undefined && s <= last.end + MERGE_THRESHOLD) {
      last.end = e;
    } else {
      windows.push({ start: s, end: e });
    }
  }

  const hunks: Hunk[] = [];
  for (const win of windows) {
    let aStart = -1;
    let bStart = -1;
    const lines: string[] = [];

    for (let k = win.start; k <= win.end; k++) {
      const op = ops[k]!;
      if (op.type === "equal") {
        if (aStart === -1) {
          aStart = op.aIdx;
          bStart = op.bIdx;
        }
        lines.push(` ${aLines[op.aIdx] ?? ""}`);
      } else if (op.type === "remove") {
        if (aStart === -1) {
          aStart = op.aIdx;
          // bStart stays at current b position — find it from previous equal or 0
          if (bStart === -1) bStart = 0;
        }
        lines.push(`-${aLines[op.aIdx] ?? ""}`);
      } else {
        // insert
        if (bStart === -1) bStart = op.bIdx;
        if (aStart === -1) {
          // pure insertion at start
          aStart = 0;
          bStart = op.bIdx;
        }
        lines.push(`+${bLines[op.bIdx] ?? ""}`);
      }
    }

    if (aStart === -1) aStart = 0;
    if (bStart === -1) bStart = 0;

    hunks.push({ aStart, bStart, lines });
  }

  // Format unified diff
  const header = `--- a/${filePath}\n+++ b/${filePath}`;
  const hunkStrings = hunks.map((h) => {
    const aCount = h.lines.filter((l) => l[0] !== "+").length;
    const bCount = h.lines.filter((l) => l[0] !== "-").length;
    const aLine = h.aStart + 1;
    const bLine = h.bStart + 1;
    const hunkHeader = `@@ -${aLine},${aCount} +${bLine},${bCount} @@`;
    return [hunkHeader, ...h.lines].join("\n");
  });

  return [header, ...hunkStrings].join("\n");
}

// ---------------------------------------------------------------------------
// applyBlock — pure function, no I/O
// ---------------------------------------------------------------------------

/**
 * Apply a single search→replace against `content`. Returns applied / not_found
 * / ambiguous. `repair` is threaded through onto a successful result so callers
 * can tell when the match only succeeded after fuzzy repair.
 */
function applySearchReplace(
  filePath: string,
  search: string,
  replace: string,
  content: string,
  repair?: ApplyResult["repair"],
): ApplyResult {
  let count = 0;
  let pos = content.indexOf(search);
  let firstPos = -1;
  while (pos !== -1) {
    count++;
    if (firstPos === -1) firstPos = pos;
    if (count > 1) break; // ambiguous — stop early
    pos = content.indexOf(search, pos + 1);
  }

  if (count === 0) return { filePath, status: "not_found" };
  if (count > 1) return { filePath, status: "ambiguous" };

  const newContent = content.slice(0, firstPos) + replace + content.slice(firstPos + search.length);
  const diff = generateDiff(content, newContent, filePath);
  return {
    filePath,
    status: "applied",
    diff,
    originalContent: content,
    newContent,
    ...(repair && { repair }),
  };
}

export function applyBlock(block: EditBlock, content: string): ApplyResult {
  const { filePath, search, replace } = block;

  // Patch-function dispatch: sentinel prefix identifies this as a PATCH block.
  if (block.format === "patch-function" && search.startsWith(PATCH_SENTINEL)) {
    const functionName = search.slice(PATCH_SENTINEL.length);
    return applyPatchBlock(
      { filePath, functionName, replacement: replace, format: "patch-function" },
      content,
    );
  }

  // Full-file replace (or new file) — guard against truncated re-emits. A small
  // model told to copy the WHOLE file back often drops the tail; writing that
  // overwrites correct code and regresses passing tests. Reject likely
  // truncations so the failed-edit re-prompt fires instead of corrupting disk.
  if (search === "") {
    const reason = truncationReason(content, replace);
    if (reason !== null) {
      return {
        filePath,
        status: "error",
        error: `whole-file write rejected: ${reason}. Re-emit the COMPLETE file, every line.`,
      };
    }
    const diff = generateDiff(content, replace, filePath);
    return {
      filePath,
      status: "applied",
      diff,
      originalContent: content,
      newContent: replace,
    };
  }

  // Search/replace: try an exact match first.
  const direct = applySearchReplace(filePath, search, replace, content);
  if (direct.status !== "not_found") return direct;

  // Exact match failed — a small model's search text frequently drifts from the
  // source (indentation, collapsed whitespace, a near-miss line). Try the fuzzy
  // repair pipeline (whitespace-normalise → per-line-trim → char-similarity) and
  // re-apply against the verbatim text it recovered.
  const repaired = repairBlock(block, content);
  if (repaired.repairedBlock !== null && repaired.strategy !== "failed") {
    const retry = applySearchReplace(filePath, repaired.repairedBlock.search, replace, content, {
      strategy: repaired.strategy,
      confidence: repaired.confidence,
    });
    if (retry.status === "applied") return retry;
  }

  return direct; // still not found
}

// ---------------------------------------------------------------------------
// Path-typo rescue
// ---------------------------------------------------------------------------

/**
 * A small model sometimes flattens the directory separators in a FILE: path,
 * emitting e.g. `src.stats.ts` for `src/stats.ts`. Left alone, the write
 * silently creates a stray new file and the real target is never edited.
 * Returns the dots-as-slashes reconstruction (every `.` before the extension →
 * `/`) so the caller can check whether that path actually exists, or null when
 * there is nothing to reconstruct. Pure — no I/O.
 */
export function flattenedPathCandidate(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or leading dot
  const stem = filePath.slice(0, dot);
  const ext = filePath.slice(dot);
  if (!stem.includes(".")) return null; // no flattened separators to restore
  const candidate = `${stem.replaceAll(".", "/")}${ext}`;
  return candidate === filePath ? null : candidate;
}

// ---------------------------------------------------------------------------
// applyBatch — orchestrates I/O via injected functions
// ---------------------------------------------------------------------------

/**
 * True for paths that are test/spec files. This harness fixes IMPLEMENTATION so
 * the existing tests pass; the tests are the ORACLE. A model that edits a test
 * to make it pass produces a fake-green — the trial reports "solved" while the
 * real bug remains. `applyBatch` rejects writes to these paths so the oracle
 * cannot be tampered with. Mirrors the `isTestPath` heuristic in context/builder.
 */
export function isTestFilePath(path: string): boolean {
  return /(?:\.test\.|\.spec\.|(?:^|\/)tests?\/|(?:^|\/)__tests__\/)/i.test(path);
}

export async function applyBatch(
  blocks: EditBlock[],
  readFile: (path: string) => Promise<string | null>,
  writeFile: (path: string, content: string) => Promise<void>,
): Promise<ApplyBatchResult> {
  const inMemory = new Map<string, string>();
  const results: ApplyResult[] = [];
  // Pre-batch on-disk content per EFFECTIVE path, stashed the first time the
  // batch touches that file. This is the content a revert must restore to (so a
  // multi-block edit to one file undoes back to before the FIRST block, not the
  // intermediate state). Absent entry ⇒ the file did not exist before the batch
  // (brand-new file) ⇒ originalContent stays undefined ⇒ revert skips it.
  const preBatchOriginal = new Map<string, string | null>();

  for (const block of blocks) {
    // Resolve the effective target path. If the emitted path is missing on disk
    // but its un-flattened variant (dots→slashes) exists, the model typo'd the
    // separators — redirect to the real file instead of creating a stray one.
    let path = block.filePath;
    if (!inMemory.has(path)) {
      const disk = await readFile(path);
      if (disk === null) {
        const alt = flattenedPathCandidate(path);
        if (alt !== null && (inMemory.has(alt) || (await readFile(alt)) !== null)) {
          path = alt;
        }
      }
    }

    // Prefer in-memory version if already modified in this batch
    let content: string;
    if (inMemory.has(path)) {
      content = inMemory.get(path)!;
    } else {
      const disk = await readFile(path);
      content = disk ?? "";
      // First touch of this effective path in the batch — stash its pre-edit
      // on-disk content (null = file did not exist) for the revert path.
      if (!preBatchOriginal.has(path)) preBatchOriginal.set(path, disk);
    }

    // Anti-fake-green: never write to a test/spec file. The tests are the oracle;
    // a model that edits them to pass produces a false "solved". Reject with
    // feedback instead, BEFORE reading/applying — no write, nothing to revert.
    // Checked on the EFFECTIVE path so a flattened typo (tests.x.test.ts) can't
    // sneak past, and on block.filePath so an unresolved test path is still caught.
    if (isTestFilePath(path) || isTestFilePath(block.filePath)) {
      results.push({
        filePath: block.filePath,
        effectivePath: path,
        status: "error",
        error:
          "edit rejected: editing test/spec files is not allowed — the tests are the specification. Fix the implementation file so the existing tests pass; do not modify the tests.",
      });
      continue;
    }

    const effectiveBlock = path === block.filePath ? block : { ...block, filePath: path };
    const result = applyBlock(effectiveBlock, content);
    // Annotate every result with the effective (actually-targeted) path and the
    // pre-batch original. applyBlock set `originalContent` to the in-memory
    // `content`; for the 2nd+ block on a file that is the intermediate state, so
    // override it with the stashed pre-batch original (or undefined for a new
    // file) so a revert fully undoes the batch.
    result.effectivePath = path;
    const stashed = preBatchOriginal.get(path);
    result.originalContent = stashed ?? undefined;
    results.push(result);

    if (result.status === "applied" && result.newContent !== undefined) {
      inMemory.set(path, result.newContent);
      await writeFile(path, result.newContent);
    }
  }

  const allApplied = results.every((r) => r.status === "applied");
  return { results, allApplied };
}
