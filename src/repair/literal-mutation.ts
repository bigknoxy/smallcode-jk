/**
 * Harness-side literal-mutation repair (pure enumeration half).
 *
 * Mirrors src/repair/operator-mutation.ts for a DISJOINT bug shape: a wrong
 * integer CONSTANT rather than a wrong operator. Operator-mutation cannot
 * touch this class at all — there is no operator to flip in `toFixed(1)`
 * when the bug is that the digit should be `2`. A small model routinely
 * cannot derive the correct constant (it has no principled way to know
 * whether a rounding/precision/threshold literal is off by one), but the
 * space of plausible off-by-one/off-by-two perturbations is tiny and the
 * oracle is deterministic — so, exactly like operator-mutation, the HARNESS
 * brute-forces it instead of asking the model to guess.
 *
 * This module is the PURE half: given file text, produce single-literal-flip
 * candidate texts in priority order (±1 before ±2, preferring the smaller,
 * more common off-by-one shift). The I/O half (write candidate → run oracle
 * → revert on miss) lives in src/agent/loop.ts (`runLiteralRepair`), where
 * the oracle and file helpers already are. No I/O here; deterministic.
 *
 * The KEY deviation from operator-mutation: operator-mutation only ever
 * scans the single locked target file. Literal-repair's I/O half additionally
 * iterates the multi-file EDITABLE SET (`state.editablePaths`, opt-in via
 * SMALLCODE_TARGET_SET) so a constant that lives in an imported helper the
 * carousel narrowed onto can also be reached — this module only enumerates
 * candidates for whatever single source string it's given; the set-iteration
 * itself is the I/O half's job.
 */

import { scopeMutationsToRange } from "./operator-mutation.ts";

export interface LiteralMutation {
  /** Full file text with ONLY this one literal occurrence replaced. */
  candidate: string;
  /** Human label, e.g. "literal 1->2". */
  label: string;
  /** 1-based line number of the literal (for logging/telemetry). */
  line: number;
  /** The original integer value. */
  base: number;
  /** The signed perturbation applied (+1, -1, +2, -2). */
  delta: number;
}

export interface EnumerateLiteralResult {
  /** Priority-ordered, capped list of single-literal-flip candidates. */
  mutations: LiteralMutation[];
  /** Total candidates before the cap (so the caller can log truncation). */
  totalFound: number;
  /** True when `totalFound > maxCandidates` and the list was truncated. */
  truncated: boolean;
}

// Priority order: the commonest off-by-one bug (+1/-1) before the wider
// off-by-two shift, and within a magnitude, +before- (increments are the more
// common direction for a too-small constant, e.g. a rounding/precision digit).
const DELTAS = [1, -1, 2, -2];

// Match a standalone non-negative integer literal: `\d+` not preceded by an
// identifier char or `.` (so `money2`, `v1`, and the `5` in `1.5` are never
// matched as the literal itself) and not followed by an identifier char or
// `.` (so `1` in `1.5` and `0x1f` are skipped, and `toFixed(1)`'s `1` — not
// followed by a word char or dot — IS matched).
const LITERAL_RE = /(?<![\w.])\d+(?![\w.])/g;

/**
 * Enumerate single-literal-flip candidates for `source`, priority-ordered
 * (±1 before ±2) and capped at `maxCandidates`. Pure: same input → same
 * output, no I/O.
 *
 * Each candidate perturbs exactly ONE integer literal occurrence and leaves
 * every other character untouched. False candidates (a size constant that
 * isn't the bug) are harmless: the oracle rejects them and the caller
 * reverts. Precision only bounds COST (oracle runs), not correctness.
 */
export function enumerateLiteralMutations(
  source: string,
  maxCandidates = 60,
): EnumerateLiteralResult {
  const all: Array<LiteralMutation & { rank: number; order: number }> = [];
  let order = 0;

  for (const m of source.matchAll(LITERAL_RE)) {
    const tok = m[0];
    // Skip a leading-zero multi-digit run (e.g. "007") to avoid octal-ish
    // oddities — keep the scan simple and stay clear of ambiguous literals.
    if (tok.length > 1 && tok[0] === "0") continue;
    const index = m.index ?? 0;
    const value = Number(tok);
    if (!Number.isFinite(value)) continue;
    const line = countLines(source, index);
    for (const delta of DELTAS) {
      const next = value + delta;
      if (next < 0) continue; // never produce a negative literal
      const rank = Math.abs(delta) * 10 + (delta < 0 ? 1 : 0); // +1(10) -1(11) +2(20) -2(21)
      all.push({
        candidate: source.slice(0, index) + String(next) + source.slice(index + tok.length),
        label: `literal ${value}->${next}`,
        line,
        base: value,
        delta,
        rank,
        order: order++,
      });
    }
  }

  // Stable sort by (rank asc, source order asc): |delta| asc, +before- within
  // a magnitude, and within a rank keep top-to-bottom file order.
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

// Re-exported so callers only need one import path when working with
// literal mutations alongside the shared range-scoping helper.
export { scopeMutationsToRange };
