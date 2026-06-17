import type { EditBlock, RepairResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize runs of spaces/tabs to a single space within a string. */
function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, " ");
}

/**
 * Build an array that maps each character position in `normalizeWhitespace(orig)`
 * back to the corresponding character position in `orig`.
 * The array has length normLen+1 (the extra slot maps the end position).
 */
function buildNormToOrigMap(orig: string): number[] {
  const map: number[] = [];
  let oi = 0;
  while (oi < orig.length) {
    const oc = orig[oi]!;
    if (oc === " " || oc === "\t") {
      // This entire whitespace run maps to a single ' ' in the norm string
      map.push(oi);
      oi++;
      while (oi < orig.length && (orig[oi] === " " || orig[oi] === "\t")) {
        oi++;
      }
    } else {
      map.push(oi);
      oi++;
    }
  }
  // sentinel: one past the last character
  map.push(oi);
  return map;
}

/**
 * Count matching characters between two strings using character-frequency overlap.
 * Lightweight similarity measure suitable for fuzzy matching.
 */
function charSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const freqA = new Map<string, number>();
  const freqB = new Map<string, number>();
  for (const c of a) freqA.set(c, (freqA.get(c) ?? 0) + 1);
  for (const c of b) freqB.set(c, (freqB.get(c) ?? 0) + 1);

  let matching = 0;
  for (const [c, cnt] of freqA) {
    matching += Math.min(cnt, freqB.get(c) ?? 0);
  }
  return matching / maxLen;
}

/**
 * Sliding-window fuzzy search: find the substring of `content` whose length
 * is within ±20% of `search.length` and maximises character-level similarity.
 * Returns { match, similarity } or null if best similarity < 0.85.
 */
function fuzzyFind(search: string, content: string): { match: string; similarity: number } | null {
  const targetLen = search.length;
  const minLen = Math.floor(targetLen * 0.8);
  const maxLen = Math.ceil(targetLen * 1.2);

  let bestSimilarity = 0;
  let bestMatch = "";

  for (let len = minLen; len <= maxLen; len++) {
    for (let start = 0; start <= content.length - len; start++) {
      const candidate = content.slice(start, start + len);
      const sim = charSimilarity(search, candidate);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatch = candidate;
      }
    }
  }

  if (bestSimilarity >= 0.85) {
    return { match: bestMatch, similarity: bestSimilarity };
  }
  return null;
}

// ---------------------------------------------------------------------------
// repairBlock
// ---------------------------------------------------------------------------

export function repairBlock(block: EditBlock, content: string): RepairResult {
  const { search, replace, filePath, format } = block;

  // Strategy 1: exact match
  if (content.includes(search)) {
    return {
      repairedBlock: { filePath, search, replace, format },
      strategy: "exact",
      confidence: 1.0,
    };
  }

  // Strategy 2: normalize runs of spaces/tabs
  {
    const normSearch = normalizeWhitespace(search);
    const normContent = normalizeWhitespace(content);
    const idx = normContent.indexOf(normSearch);
    if (idx !== -1) {
      const origMap = buildNormToOrigMap(content);
      const origStart = origMap[idx];
      const origEnd = origMap[idx + normSearch.length];
      if (origStart !== undefined && origEnd !== undefined) {
        const exactMatch = content.slice(origStart, origEnd);
        if (content.includes(exactMatch)) {
          const repairedBlock: EditBlock = { filePath, search: exactMatch, replace, format };
          return { repairedBlock, strategy: "whitespace", confidence: 0.85 };
        }
      }
    }
  }

  // Strategy 3: trim each line
  {
    const exactMatch = findExactFromTrimmed(search, content);
    if (exactMatch !== null && content.includes(exactMatch)) {
      const repairedBlock: EditBlock = { filePath, search: exactMatch, replace, format };
      return { repairedBlock, strategy: "whitespace", confidence: 0.8 };
    }
  }

  // Strategy 4: fuzzy match (last resort)
  {
    const found = fuzzyFind(search, content);
    if (found !== null) {
      const repairedBlock: EditBlock = {
        filePath,
        search: found.match,
        replace,
        format,
      };
      return { repairedBlock, strategy: "fuzzy", confidence: found.similarity };
    }
  }

  return { repairedBlock: null, strategy: "failed", confidence: 0 };
}

// ---------------------------------------------------------------------------
// Internal helper for per-line trim strategy
// ---------------------------------------------------------------------------

/**
 * Find the verbatim substring in `content` that corresponds to `search`
 * after per-line trimming.  Aligns line-by-line.
 */
function findExactFromTrimmed(search: string, content: string): string | null {
  const searchLines = search.split("\n");
  const contentLines = content.split("\n");
  const trimmedSearchLines = searchLines.map((l) => l.trim());
  const trimmedContentLines = contentLines.map((l) => l.trim());

  outer: for (let start = 0; start <= contentLines.length - searchLines.length; start++) {
    for (let k = 0; k < trimmedSearchLines.length; k++) {
      if (trimmedContentLines[start + k] !== trimmedSearchLines[k]) {
        continue outer;
      }
    }
    // Match found at line `start`
    return contentLines.slice(start, start + searchLines.length).join("\n");
  }
  return null;
}
