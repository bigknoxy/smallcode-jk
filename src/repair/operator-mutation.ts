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

// Per-operator flip table. `rank` orders candidates globally: 0 = equality
// inversion (most common wrong-operator bug, and the safest single-char class),
// 1 = boundary off-by-one (`<`↔`<=`), 2 = relational inversion (`<`↔`>=`). Lower
// rank is tried first so the cheapest/likeliest fix wins before costlier ones.
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
};

// Tokens matched-and-consumed but NEVER mutated: shift operators and the arrow.
// Matching them explicitly (longest-first, ahead of the bare `<`/`>` alternatives)
// stops us from mis-reading the `>` of `=>` or a `<` of `<<` as a comparison.
const SKIP = new Set(["<<", ">>", "=>"]);

// Longest-first alternation so `===` wins over `==`, `<=` over `<`, and the SKIP
// tokens (`<<`,`>>`,`=>`) are consumed whole rather than leaving a stray `<`/`>`.
const OP_RE = /===|!==|==|!=|<=|>=|<<|>>|=>|<|>/g;

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
