import type { CodeSymbol, FileMap } from "./types.ts";

export interface ScoredFile {
  fileMap: FileMap;
  score: number;
  matchedSymbols: CodeSymbol[];
}

// Tokenize a query string: split on non-alphanumeric/underscore chars, filter < 2 chars.
function tokenizeQuery(query: string): string[] {
  return query
    .split(/[^a-zA-Z0-9_]/)
    .filter((t) => t.length >= 2)
    .map((t) => t.toLowerCase());
}

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
          // Signal 1: exact symbol name match (+10)
          symScore += 10;
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

    return { fileMap, score, matchedSymbols };
  });

  // Sort descending by score; zero-scored files go last but are included.
  scored.sort((a, b) => b.score - a.score);

  return scored;
}
