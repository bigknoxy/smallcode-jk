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
  "scripts", // dev tooling / one-off probes — rarely the mechanism-fix target
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

/**
 * Dominant boost for a file whose repo-relative path is named VERBATIM in the
 * query (e.g. the task says "In src/cli/args.ts, parseArgs …"). Naming the exact
 * path is the single strongest target signal a human can give — far stronger than
 * any pile of partial symbol matches — yet without this a small file (few symbols
 * → low aggregate) loses to a big decoy that substring-matches common query words
 * ("value"/"token"/"test"/"pass") across dozens of its own symbols. Real case:
 * args.ts (2 symbols, named in the query) ranked 36th behind progress.ts (126)
 * and oracle.ts (84). Set an order of magnitude above the largest observed
 * partial-match pile so an explicit path mention always wins its tier; when two
 * real files are both named, the normal signals below tie-break between them.
 */
const PATH_MENTION_WEIGHT = 1000;

/**
 * Cap on the AGGREGATE partial-substring symbol-match score (signal 2) a single
 * file can earn. Partial matches are weak "this file mentions the concept"
 * evidence; unbounded, they let a big aggregator/barrel file (dozens of symbols,
 * each partial-matching a common task word like "file"/"run"/"add") pile up a
 * score that swamps the small module actually DEFINING the mechanism. Exact
 * symbol matches (signal 1) and the basename definer signal are NOT capped — only
 * the noise is. Set at ~4 partial hits, above which more matches signal "big
 * file" rather than "better target". Real dogfood failure this addresses: an
 * operator-mutation task ranked loop.ts (the caller, many symbols) over
 * operator-mutation.ts (the definer, few symbols).
 */
const PARTIAL_MATCH_CAP = 12;

/**
 * Per-token weight for a query token that matches a token of the file's BASENAME
 * (filename minus extension, split on non-alphanumeric). A file literally NAMED
 * for the concept the task is about (`operator-mutation.ts` for an "operator
 * mutation" task) is the DEFINER of that mechanism; a file that merely USES the
 * mechanism accumulates only partial substring hits on its own symbol names.
 * This is the "defines over uses" signal: without it, retrieval on a large repo
 * locks onto the orchestration file that references a mechanism instead of the
 * small module that defines it (real dogfood failure: an operator-mutation task
 * locked onto loop.ts, the caller, not operator-mutation.ts, the enumerator).
 * Weighted at ~one exact-symbol so a single named-file match clears the generic
 * substring noise a big decoy piles up from common task words (add/for/pass).
 */
const BASENAME_TOKEN_WEIGHT = 22;

/**
 * Basename tokens too STRUCTURAL to indicate a file is named for a concept.
 * These name a file's role in the module layout (a barrel, a util grab-bag, an
 * entrypoint), not the mechanism it defines, so matching one is not evidence of
 * "definer". Excluding them lets BASENAME_TOKEN_WEIGHT run high enough to clear
 * decoy symbol-piles without resurrecting an `index.ts` barrel or a
 * `file-utils.ts` grab-bag every time a task sentence says "file" or "index".
 */
const GENERIC_BASENAME_TOKENS = new Set([
  "index",
  "main",
  "file",
  "util",
  "utils",
  "helper",
  "helpers",
  "core",
  "base",
  "common",
  "types",
  "type",
  "node",
  "code",
  "data",
  "lib",
  "mod",
]);

/**
 * Extra boost when TWO OR MORE distinct query tokens match the basename — a
 * compound-named file (`operator-mutation`, `read-after-delete`, `target-set`)
 * whose name reproduces multiple task nouns is almost certainly the definer, a
 * far stronger and rarer signal than a single common-word filename hit. Kept
 * well below PATH_MENTION_WEIGHT so an explicitly-named path always still wins.
 */
const BASENAME_COMPOUND_BONUS = 25;

/**
 * Minimum basename-token length considered for the "defines" signal. Short
 * fragments ("to", "of", "id", "js") are too generic to indicate a file is
 * named for a concept and would false-fire on decoys. Pure.
 */
const MIN_BASENAME_TOKEN_LEN = 4;

/**
 * Tokenize a file's basename (drop directory + extension, split on
 * non-alphanumeric) into lower-cased fragments of at least MIN_BASENAME_TOKEN_LEN
 * chars. `src/repair/operator-mutation.ts` → ["operator", "mutation"]. Pure.
 */
function tokenizeBasename(path: string): string[] {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, "");
  return base
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= MIN_BASENAME_TOKEN_LEN && !GENERIC_BASENAME_TOKENS.has(t));
}

/**
 * True when two lower-cased tokens name the same concept: equal, or sharing a
 * common prefix of at least MIN_BASENAME_TOKEN_LEN chars (so "walker"~"walks",
 * "scorer"~"scored", "planner"~"planning" — but NOT "wall"~"walk", 3-char share).
 * Prefix, not arbitrary substring, so unrelated tokens that merely share a middle
 * fragment don't collide. Pure.
 */
function tokensAkin(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < MIN_BASENAME_TOKEN_LEN || b.length < MIN_BASENAME_TOKEN_LEN) return false;
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return i >= MIN_BASENAME_TOKEN_LEN;
}

/**
 * "Defines over uses" score for a file: how strongly the file's BASENAME is
 * named after the query's concept tokens. Counts DISTINCT query tokens that
 * match a basename token (exact, or one is a prefix of the other with the shared
 * prefix ≥ MIN_BASENAME_TOKEN_LEN — so "walker" matches "walks"/"walk" but not
 * "wall"). Returns 0 when nothing matches (the common case → no ranking change).
 * Pure.
 */
function definerScore(basenameTokens: string[], queryTokens: string[]): number {
  if (basenameTokens.length === 0) return 0;
  const matched = new Set<string>();
  for (const qt of queryTokens) {
    for (const bt of basenameTokens) {
      if (tokensAkin(qt, bt)) {
        matched.add(bt);
        break;
      }
    }
  }
  const count = matched.size;
  if (count === 0) return 0;
  return BASENAME_TOKEN_WEIGHT * count + (count >= 2 ? BASENAME_COMPOUND_BONUS : 0);
}

/**
 * True when `query` names `path` verbatim as a repo-relative path. The path is
 * distinctive (contains a "/" separator and/or a file extension), so a plain
 * substring test can't false-match a bare word. Slashes are normalized so a
 * Windows-style candidate path still matches a forward-slash mention (queries are
 * written with "/"). Pure.
 */
function queryMentionsPath(query: string, path: string): boolean {
  const normPath = path.replace(/\\/g, "/").toLowerCase();
  if (normPath.length < 3) return false;
  return query.replace(/\\/g, "/").toLowerCase().includes(normPath);
}

export function scoreFiles(files: FileMap[], query: string): ScoredFile[] {
  const tokens = tokenizeQuery(query);

  const scored = files.map((fileMap): ScoredFile => {
    let score = 0;
    const matchedSymbols: CodeSymbol[] = [];
    const pathLower = fileMap.path.toLowerCase();

    // Signal 0 (dominant): the query names this file's exact path — the strongest
    // possible target signal, applied before the partial-match signals so no pile
    // of decoy substring hits can outrank an explicitly-named file.
    if (queryMentionsPath(query, fileMap.path)) {
      score += PATH_MENTION_WEIGHT;
    }

    // Signal 0.5 (defines over uses): the file's BASENAME is named after the
    // query's concept tokens → it likely DEFINES the mechanism rather than
    // merely using it. Applied before the partial-match signals so a named-file
    // definer clears the generic-word substring noise a big decoy accumulates.
    score += definerScore(tokenizeBasename(fileMap.path), tokens);

    // Signal 3: file path contains query token (+2 per matching token)
    for (const token of tokens) {
      if (pathLower.includes(token)) {
        score += 2;
      }
    }

    // Signals 1, 2, 4: symbol-level scoring. EXACT matches (signal 1) are the
    // definer signal and stay uncapped; PARTIAL substring matches (signal 2) are
    // the "uses" noise — they accumulate without bound across a big aggregator's
    // dozens of symbols and swamp a small definer module, so their aggregate is
    // capped (see PARTIAL_MATCH_CAP). This is the other half of "defines over
    // uses": stop a barrel/orchestration file from out-scoring the module that
    // defines the mechanism purely by having more symbols to partial-match.
    let exactScore = 0;
    let partialScore = 0;
    for (const sym of fileMap.symbols) {
      const nameLower = sym.name.toLowerCase();
      let symExact = 0;
      let symPartial = 0;

      for (const token of tokens) {
        if (nameLower === token) {
          // Signal 1: exact symbol name match — dominant target signal.
          symExact += EXACT_NAME_WEIGHT;
        } else if (nameLower.includes(token)) {
          // Signal 2: partial symbol name match (+3)
          symPartial += 3;
        }
      }

      // Signal 4: function/method kind boost (+1) — applied once if the symbol
      // matched at all, on whichever bucket it contributed to.
      if (sym.kind === "function" || sym.kind === "method") {
        if (symExact > 0) symExact += 1;
        else if (symPartial > 0) symPartial += 1;
      }

      if (symExact > 0 || symPartial > 0) {
        exactScore += symExact;
        partialScore += symPartial;
        matchedSymbols.push(sym);
      }
    }
    score += exactScore + Math.min(partialScore, PARTIAL_MATCH_CAP);

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
