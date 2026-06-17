import type { ApplyBatchResult, ApplyResult, EditBlock } from "./types.ts";

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

export function applyBlock(block: EditBlock, content: string): ApplyResult {
  const { filePath, search, replace } = block;

  // Full-file replace (or new file)
  if (search === "") {
    const diff = generateDiff(content, replace, filePath);
    return {
      filePath,
      status: "applied",
      diff,
      originalContent: content,
      newContent: replace,
    };
  }

  // Count occurrences
  let count = 0;
  let pos = content.indexOf(search);
  let firstPos = -1;
  while (pos !== -1) {
    count++;
    if (firstPos === -1) firstPos = pos;
    if (count > 1) break; // ambiguous — stop early
    pos = content.indexOf(search, pos + 1);
  }

  if (count === 0) {
    return { filePath, status: "not_found" };
  }
  if (count > 1) {
    return { filePath, status: "ambiguous" };
  }

  // Exactly one match
  const newContent = content.slice(0, firstPos) + replace + content.slice(firstPos + search.length);
  const diff = generateDiff(content, newContent, filePath);
  return {
    filePath,
    status: "applied",
    diff,
    originalContent: content,
    newContent,
  };
}

// ---------------------------------------------------------------------------
// applyBatch — orchestrates I/O via injected functions
// ---------------------------------------------------------------------------

export async function applyBatch(
  blocks: EditBlock[],
  readFile: (path: string) => Promise<string | null>,
  writeFile: (path: string, content: string) => Promise<void>,
): Promise<ApplyBatchResult> {
  const inMemory = new Map<string, string>();
  const results: ApplyResult[] = [];

  for (const block of blocks) {
    // Prefer in-memory version if already modified in this batch
    let content: string;
    if (inMemory.has(block.filePath)) {
      content = inMemory.get(block.filePath)!;
    } else {
      const disk = await readFile(block.filePath);
      content = disk ?? "";
    }

    const result = applyBlock(block, content);
    results.push(result);

    if (result.status === "applied" && result.newContent !== undefined) {
      inMemory.set(block.filePath, result.newContent);
      await writeFile(block.filePath, result.newContent);
    }
  }

  const allApplied = results.every((r) => r.status === "applied");
  return { results, allApplied };
}
