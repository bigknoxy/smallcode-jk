/**
 * Harness-side boolean-mutation repair (pure enumeration half) — E4-T2, the first
 * new archetype built on the E4-T1 pluggable interface.
 *
 * A DISJOINT bug shape from operator/literal: a wrong boolean DEFAULT — the code
 * returns/assigns `true` where it should be `false` (or vice-versa). No operator
 * to flip, no integer to perturb; the value itself is inverted. A small model
 * routinely picks the wrong polarity for a guard/flag/predicate default, and the
 * space is tiny (each standalone `true`/`false` literal has exactly one flip), so
 * — exactly like operator/literal repair — the HARNESS brute-forces it against the
 * deterministic oracle instead of asking the model to guess.
 *
 * This module is the PURE half: given file text, produce single-boolean-flip
 * candidate texts. The I/O half (write → oracle → revert) is the shared archetype
 * driver (`runArchetypeRepair`) via `booleanArchetype` in src/agent/loop.ts,
 * gated by SMALLCODE_BOOL_REPAIR (default OFF until an A/B justifies promotion).
 */

import { scopeMutationsToRange } from "./operator-mutation.ts";

export interface BooleanMutation {
  /** Full file text with ONLY this one boolean occurrence flipped. */
  candidate: string;
  /** Human label, e.g. "boolean true->false". */
  label: string;
  /** 1-based line number of the literal. */
  line: number;
}

export interface EnumerateBooleanResult {
  mutations: BooleanMutation[];
  totalFound: number;
  truncated: boolean;
}

// Standalone `true`/`false` keyword, not part of an identifier/property (so
// `trueish`, `isFalse`, `x.true` are never matched). Word boundaries via
// negative look-around on identifier chars and `.`.
const BOOL_RE = /(?<![\w.])(true|false)(?![\w.])/g;
const FLIP: Record<string, string> = { true: "false", false: "true" };

/**
 * Enumerate single-boolean-flip candidates for `source`, in file order, capped at
 * `maxCandidates`. Pure. A false candidate (a boolean that isn't the bug) is
 * harmless — the oracle rejects it and the caller reverts; precision only bounds
 * COST (oracle runs), not correctness.
 */
export function enumerateBooleanMutations(source: string, maxCandidates = 60): EnumerateBooleanResult {
  const all: BooleanMutation[] = [];
  for (const m of source.matchAll(BOOL_RE)) {
    const tok = m[0];
    const index = m.index ?? 0;
    all.push({
      candidate: source.slice(0, index) + FLIP[tok] + source.slice(index + tok.length),
      label: `boolean ${tok}->${FLIP[tok]}`,
      line: countLines(source, index),
    });
  }
  const totalFound = all.length;
  return { mutations: all.slice(0, maxCandidates), totalFound, truncated: totalFound > maxCandidates };
}

/** 1-based line number of the character at `index` in `text`. */
function countLines(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export { scopeMutationsToRange };
