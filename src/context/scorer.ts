import { isTestFilePath } from "@/edit/applier.ts";
import type { CodeSymbol, FileMap } from "./types.ts";

export interface ScoredFile {
  fileMap: FileMap;
  score: number;
  matchedSymbols: CodeSymbol[];
}

/**
 * Path segments that mark a file as test/fixture/vendor/example/generated data
 * rather than application source. A repo with a large fixture/vendor tree (e.g.
 * smallcode's own `evals/fixtures/**`, 344 near-duplicate source files) can
 * contain a FIXTURE copy of the exact file being fixed — lexically identical to
 * the real source — which would otherwise tie or even outrank it in retrieval.
 */
const LOW_PRIORITY_SEGMENTS = new Set([
  "fixtures",
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
  "testdata",
  "test-data",
  "examples",
  "example",
  "vendor",
  "third_party",
  "node_modules", // already walked out; kept here for defense-in-depth
]);

/**
 * True when `path` looks like test/fixture/vendor/example/generated data rather
 * than real application source. Used ONLY to deprioritize EDIT TARGET selection
 * (`scoreFiles`'s multiplicative penalty) — it does NOT hide the file from
 * context; tests/fixtures remain visible as reference material, just not chosen
 * as the file to edit. Reuses `isTestFilePath` (the same heuristic `applyBatch`
 * uses to reject test-file WRITES) so the two never drift on what counts as a
 * test path. Pure — no I/O.
 */
export function isLowPriorityTargetPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length > 0) {
    const top = segments[0]!.toLowerCase();
    if (top === "evals" || top === "eval") return true;
  }
  for (const seg of segments) {
    if (LOW_PRIORITY_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  return isTestFilePath(normalized);
}

/**
 * Multiplicative penalty applied to a low-priority (test/fixture/vendor/example)
 * path's score. Gated on score > 0 by the caller so a zero-score file is never
 * resurrected — this only WIDENS the gap between a real source file and a
 * lexically-identical fixture/vendor twin (or breaks an exact tie), it never
 * changes ranking when no such paths are in play (the common case / the
 * retrieval probes).
 */
const LOW_PRIORITY_PENALTY = 0.25;

// Tokenize a query string: split on non-alphanumeric/underscore chars, filter < 2 chars.
function tokenizeQuery(query: string): string[] {
  return query
    .split(/[^a-zA-Z0-9_]/)
    .filter((t) => t.length >= 2)
    .map((t) => t.toLowerCase());
}

/**
 * Exact symbol-name match weight. A file that DEFINES the exact identifier the
 * task names (e.g. the query says "fix `toKebab`" and this file exports `toKebab`)
 * is the single strongest target signal. Set high enough that ONE exact match
 * beats the partial-substring noise a big decoy accumulates — without it, a query
 * that merely mentions a decoy's filename ("…src/table.ts already passes") lets
 * "table" substring-match that file's own `renderTable`/`renderTableWith` symbols
 * and outrank the real target. One exact ≈ five partials.
 */
const EXACT_NAME_WEIGHT = 15;

export function scoreFiles(files: FileMap[], query: string): ScoredFile[] {
  const tokens = tokenizeQuery(query);

  const scored = files.map((fileMap): ScoredFile => {
    let score = 0;
    const matchedSymbols: CodeSymbol[] = [];
    const pathLower = fileMap.path.toLowerCase();

    // Signal 3: file path contains query token (+2 per matching token)
    for (const token of tokens) {
      if (pathLower.includes(token)) {
        score += 2;
      }
    }

    // Signals 1, 2, 4: symbol-level scoring
    for (const sym of fileMap.symbols) {
      const nameLower = sym.name.toLowerCase();
      let symScore = 0;

      for (const token of tokens) {
        if (nameLower === token) {
          // Signal 1: exact symbol name match — dominant target signal.
          symScore += EXACT_NAME_WEIGHT;
        } else if (nameLower.includes(token)) {
          // Signal 2: partial symbol name match (+3)
          symScore += 3;
        }
      }

      // Signal 4: function/method kind boost (+1)
      if (sym.kind === "function" || sym.kind === "method") {
        if (symScore > 0) {
          symScore += 1;
        }
      }

      if (symScore > 0) {
        score += symScore;
        matchedSymbols.push(sym);
      }
    }

    // Deprioritize test/fixture/vendor/example paths for TARGET selection —
    // gated on score > 0 so a zero-score file is never resurrected above zero.
    if (score > 0 && isLowPriorityTargetPath(fileMap.path)) {
      score *= LOW_PRIORITY_PENALTY;
    }

    return { fileMap, score, matchedSymbols };
  });

  // Sort descending by score; zero-scored files go last but are included.
  scored.sort((a, b) => b.score - a.score);

  return scored;
}
