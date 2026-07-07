/**
 * Harness-side operator-mutation repair (pure enumeration half).
 *
 * Motivation: the mri floor-task forensics ([[project_r2_mri_probe]]) proved that
 * for a whole class of bugs — a single wrong comparison operator — NO model-side
 * lever moves the needle. Handing the model the exact line (R2), a bigger model
 * (32b), and a minimal-edit prompt ALL scored ~0: a sub-14B model cannot reliably
 * flip `!== 45` → `=== 45` while preserving the surrounding short-circuit idiom, so
 * it over-rewrites and breaks it. The operator space, however, is tiny and the
 * oracle is deterministic — so the HARNESS can brute-force it. Enumerate every
 * comparison-operator occurrence in the fix target, flip each one, and run the
 * real oracle on each candidate; keep the first that goes fully green. This routes
 * around the model's idiom-comprehension wall entirely.
 *
 * This module is the PURE half: given file text, produce single-operator-flip
 * candidate texts in priority order (equality inversions first — the most common
 * bug and the safest flip — then boundary off-by-one, then relational inversion).
 * The I/O half (write candidate → run oracle → revert on miss) lives in the loop,
 * where the oracle and file helpers already are. No I/O here; deterministic.
 *
 * The enumerator's output is later SCOPED (via `scopeMutationsToRange`, also in
 * this module) to the locked target function's line range by the I/O half, so an
 * operator flip outside the bug function is never tried against the oracle.
 */

export interface OperatorMutation {
  /** 0-based char offset of the operator token in the source. */
  index: number;
  /** 1-based line number of the operator (for logging/telemetry). */
  line: number;
  /** The original operator token, e.g. "!==". */
  original: string;
  /** The flipped operator token, e.g. "===". */
  mutated: string;
  /** Short category: "eq-invert" | "boundary" | "rel-invert". */
  kind: string;
  /** Human label, e.g. "!== -> ===". */
  label: string;
  /** Full file text with ONLY this one operator occurrence replaced. */
  candidate: string;
}

// Per-operator flip table. `rank` orders candidates globally so the cheapest/
// likeliest/safest fix is tried first:
//   0 equality inversion (`===`↔`!==`) — commonest wrong-operator bug, safest
//   1 boundary off-by-one (`<`↔`<=`)
//   2 relational inversion (`<`↔`>=`)
//   3 logical (`&&`↔`||`)          — small clean token set; the exact class the
//     mri model kept mis-writing when it over-rewrote a comparison fix
//   4 arithmetic (`+`↔`-`)         — classic sign/delta bug; most COMMON token in
//     real code, so ranked last (tried only after the tighter classes) and the
//     first to be shed by the candidate cap on a large file
const FLIPS: Record<string, Array<{ to: string; rank: number; kind: string }>> = {
  "===": [{ to: "!==", rank: 0, kind: "eq-invert" }],
  "!==": [{ to: "===", rank: 0, kind: "eq-invert" }],
  "==": [{ to: "!=", rank: 0, kind: "eq-invert" }],
  "!=": [{ to: "==", rank: 0, kind: "eq-invert" }],
  "<": [
    { to: "<=", rank: 1, kind: "boundary" },
    { to: ">=", rank: 2, kind: "rel-invert" },
    { to: ">", rank: 2, kind: "rel-invert" },
  ],
  ">": [
    { to: ">=", rank: 1, kind: "boundary" },
    { to: "<=", rank: 2, kind: "rel-invert" },
    { to: "<", rank: 2, kind: "rel-invert" },
  ],
  "<=": [
    { to: "<", rank: 1, kind: "boundary" },
    { to: ">", rank: 2, kind: "rel-invert" },
  ],
  ">=": [
    { to: ">", rank: 1, kind: "boundary" },
    { to: "<", rank: 2, kind: "rel-invert" },
  ],
  "&&": [{ to: "||", rank: 3, kind: "logical" }],
  "||": [{ to: "&&", rank: 3, kind: "logical" }],
  "+": [{ to: "-", rank: 4, kind: "arith" }],
  "-": [{ to: "+", rank: 4, kind: "arith" }],
};

// Tokens matched-and-consumed but NEVER mutated. Matching them explicitly
// (longest-first, ahead of the single-char alternatives) stops us from mis-reading
// a compound token's piece as an operator: the `>` of `=>`, a `<` of `<<`, or the
// `+`/`-` of `++`/`--`/`+=`/`-=`. Without this a `+=` would be flipped to `-=`
// (mangling an assignment) and `i++` to `i+-` (a syntax error) — both wasted
// candidates at best, so we consume-and-skip them whole.
const SKIP = new Set(["<<", ">>", "=>", "++", "--", "+=", "-="]);

// Longest-first alternation so multi-char tokens win over their single-char
// pieces (`===` over `==`, `<=` over `<`, `++`/`+=` over `+`, `&&` before a bare
// `+`) and the SKIP tokens are consumed whole rather than leaving a stray operator.
// Note: bare `|` (bitwise-or) and `&` (bitwise-and) are intentionally NOT matched —
// only the doubled logical forms `||`/`&&` are, so `a | b` and `x |= y` are left
// untouched.
const OP_RE = /===|!==|==|!=|<=|>=|<<|>>|=>|&&|\|\||\+\+|--|\+=|-=|\+|-|<|>/g;

export interface EnumerateResult {
  /** Priority-ordered, capped list of single-operator-flip candidates. */
  mutations: OperatorMutation[];
  /** Total candidates before the cap (so the caller can log truncation). */
  totalFound: number;
  /** True when `totalFound > maxCandidates` and the list was truncated. */
  truncated: boolean;
}

/**
 * Enumerate single-operator-flip candidates for `source`, priority-ordered
 * (equality inversions first, then boundary, then relational) and capped at
 * `maxCandidates`. Pure: same input → same output, no I/O.
 *
 * Each candidate flips exactly ONE operator occurrence and leaves every other
 * character untouched — the minimal edit a small model cannot reliably make
 * itself. False candidates (a `<` inside a generic, a flip that doesn't fix the
 * bug) are harmless: the oracle rejects them and the caller reverts. Precision
 * only bounds COST (oracle runs), not correctness, so the cap is the real guard.
 */
export function enumerateComparisonMutations(
  source: string,
  maxCandidates = 60,
): EnumerateResult {
  const all: Array<OperatorMutation & { rank: number; order: number }> = [];
  let order = 0;

  // Precompute line starts for O(1)-ish line lookup as we scan forward.
  for (const m of source.matchAll(OP_RE)) {
    const tok = m[0];
    if (SKIP.has(tok)) continue;
    const flips = FLIPS[tok];
    if (flips === undefined) continue;
    const index = m.index ?? 0;
    const line = countLines(source, index);
    for (const f of flips) {
      all.push({
        index,
        line,
        original: tok,
        mutated: f.to,
        kind: f.kind,
        label: `${tok} -> ${f.to}`,
        candidate: source.slice(0, index) + f.to + source.slice(index + tok.length),
        rank: f.rank,
        order: order++,
      });
    }
  }

  // Stable sort by (rank asc, source order asc): equality flips first, and within
  // a rank keep top-to-bottom file order (earlier bugs tried first).
  all.sort((a, b) => (a.rank - b.rank) || (a.order - b.order));

  const totalFound = all.length;
  const mutations = all.slice(0, maxCandidates).map(({ rank: _r, order: _o, ...rest }) => rest);
  return { mutations, totalFound, truncated: totalFound > maxCandidates };
}

/** 1-based line number of the character at `index` in `text`. */
function countLines(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export interface LineRange {
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
}

/**
 * Keep only mutation candidates whose operator falls INSIDE `range` (1-based,
 * inclusive) — the locked target function. A flip in an unrelated helper that
 * coincidentally greens a weakly-covered test can no longer be selected. When
 * `range` is undefined (target function unknown) the list is returned unchanged
 * (conservative whole-file fallback). Pure; same input → same output.
 */
export function scopeMutationsToRange<T extends { line: number }>(
  items: T[],
  range: LineRange | undefined,
): T[] {
  if (range === undefined) return items;
  return items.filter((m) => m.line >= range.startLine && m.line <= range.endLine);
}
