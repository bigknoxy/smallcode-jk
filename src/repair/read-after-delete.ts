/**
 * Read-after-delete repair (pure scan/regex half).
 *
 * Motivation: the lru-recency floor-task forensics ([[project_lru_recency_floor]])
 * proved that when a sub-14B model fixes an LRU cache it localizes the bug
 * PERFECTLY yet still writes a consistent read-after-delete ordering mistake —
 * the right shape in the wrong order. The canonical failure, straight out of the
 * transcripts:
 *
 *   function get(key) {
 *     if (map.has(key)) {
 *       map.delete(key);
 *       map.set(key, map.get(key));   // BUG: get() runs AFTER delete -> undefined
 *     }
 *     return map.get(key);
 *   }
 *
 * `map.get(key)` is evaluated as the argument to `map.set` AFTER `map.delete(key)`
 * has already removed the entry, so the value re-inserted is `undefined`. The fix
 * is to read the value into a temp BEFORE deleting. That reorder is not an
 * operator flip (operator-mutation.ts can't touch it) and it is not a
 * localization miss the model could be nudged past — it is a stubbornly repeated
 * ordering bug. Two levers fall out, both pure and both here:
 *
 *   1. A DETECTOR (`detectReadAfterDelete`) that recognizes the anti-pattern in
 *      the model's output and produces a precise one-line hint to feed back to
 *      the model. Precision matters: a false hint misleads the model, so the
 *      matcher is deliberately conservative — it only fires on the exact
 *      `X.set(K, X.get(K))`-after-`X.delete(K)` store, with no intervening
 *      correct re-set.
 *
 *   2. A deterministic HARNESS-side REPAIR (`repairReadAfterDelete`) that, for a
 *      single unambiguous finding, hoists the read into a temp before the delete
 *      and rewrites the store. The caller runs a real oracle on the candidate and
 *      reverts on a miss, so precision only bounds COST there — but the transform
 *      is kept correct for the canonical case regardless.
 *
 * Like operator-mutation.ts this is the PURE half: given file text, produce a
 * finding list / a single rewritten candidate. No I/O; deterministic. Scan/regex
 * only — no AST library, matching the sibling module's discipline.
 */

// A bare identifier: `map`, `cache`, `_store`, `$m`.
const ID = "[A-Za-z_$][\\w$]*";
// A key expression: a bare identifier or a dotted member chain (`a`, `a.b`,
// `opts.key`). Whitespace around the dots is tolerated and normalized away when
// two key texts are compared.
const KEY = `${ID}(?:\\s*\\.\\s*${ID})*`;

// `X.delete(K)` where X is a simple identifier and K is a simple/dotted key.
const DELETE_RE = new RegExp(`(${ID})\\s*\\.\\s*delete\\s*\\(\\s*(${KEY})\\s*\\)`, "g");

// The offending store `X.set(K, X.get(K))` — the `.get` is the WHOLE second
// argument (note the `)` immediately closing the `set` after the `get`), which is
// the exact undefined-store. Group 3 captures the entire `X.get(K)` expression so
// its char span can be spliced out during repair (the `d` flag exposes indices).
//   1=setObj  2=setKey  3=getExpr  4=getObj  5=getKey
const SETGET_RE = new RegExp(
  `(${ID})\\s*\\.\\s*set\\s*\\(\\s*(${KEY})\\s*,\\s*((${ID})\\s*\\.\\s*get\\s*\\(\\s*(${KEY})\\s*\\))\\s*\\)`,
  "dg",
);

// Any `X.set(K, …)` store (prefix only — we don't care about the value). Used to
// detect a CORRECT re-set sitting between the delete and the offending set, which
// disqualifies the finding (the value was already restored).
const SETANY_RE = new RegExp(`(${ID})\\s*\\.\\s*set\\s*\\(\\s*(${KEY})\\s*,`, "g");

/** Normalize a key expression for comparison: strip ALL whitespace so `a.b`,
 * `a . b`, and `a.\n b` compare equal. Keys here are identifiers/dotted members,
 * so removing whitespace never changes their meaning. */
function normKey(k: string): string {
  return k.replace(/\s+/g, "");
}

export interface ReadAfterDeleteFinding {
  /** The receiver identifier text, e.g. "map". */
  object: string;
  /** The key expression text, verbatim as written at the store, e.g. "key". */
  key: string;
  /** 1-based line of the `X.delete(K)` call. */
  deleteLine: number;
  /** 1-based line of the offending `X.set(K, X.get(K))`. */
  setLine: number;
  /** One-line human hint pointing at the fix. */
  hint: string;
}

// Internal richer finding carrying char spans, so `repairReadAfterDelete` can
// splice without re-matching. Not exported — the public shape stays minimal.
interface RawFinding extends ReadAfterDeleteFinding {
  /** 0-based char offset of the `X.delete(K)` call. */
  deleteIndex: number;
  /** 0-based char offset of the offending `X.set(...)` call. */
  setIndex: number;
  /** 0-based char offset of the `X.get(K)` argument inside the set. */
  getArgIndex: number;
  /** Char length of that `X.get(K)` argument. */
  getArgLen: number;
}

function collect(source: string): RawFinding[] {
  // All deletes, in source order, with their end offset (for the intervening
  // window) — reused across every candidate set.
  const deletes = [...source.matchAll(DELETE_RE)].map((m) => ({
    object: m[1]!,
    key: m[2]!,
    index: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));

  // All `X.set(K, …)` prefixes, for the intervening-correct-reset check.
  const anySets = [...source.matchAll(SETANY_RE)].map((m) => ({
    object: m[1]!,
    key: m[2]!,
    index: m.index ?? 0,
  }));

  const findings: RawFinding[] = [];

  // Drive off the offending stores so each `X.set(K, X.get(K))` yields at most
  // one finding, tied back to its nearest preceding matching delete.
  for (const m of source.matchAll(SETGET_RE)) {
    const setObj = m[1]!;
    const setKey = m[2]!;
    const getObj = m[4]!;
    const getKey = m[5]!;
    const setIndex = m.index ?? 0;

    // The store must read back the SAME object and SAME key it writes.
    if (setObj !== getObj) continue;
    if (normKey(setKey) !== normKey(getKey)) continue;
    const nKey = normKey(setKey);

    // Nearest preceding `X.delete(K)` on the same object + key.
    let del: (typeof deletes)[number] | null = null;
    for (const d of deletes) {
      if (d.index >= setIndex) continue;
      if (d.object !== setObj) continue;
      if (normKey(d.key) !== nKey) continue;
      if (del === null || d.index > del.index) del = d;
    }
    if (del === null) continue;

    // Disqualify if a correct re-set on the same object+key sits strictly
    // between the delete and this offending set.
    const intervening = anySets.some(
      (s) =>
        s.index > del!.end &&
        s.index < setIndex &&
        s.object === setObj &&
        normKey(s.key) === nKey,
    );
    if (intervening) continue;

    const indices = (m as RegExpMatchArray & { indices?: Array<[number, number]> }).indices!;
    const [getArgIndex, getArgEnd] = indices[3]!;

    findings.push({
      object: setObj,
      key: setKey,
      deleteLine: countLines(source, del.index),
      setLine: countLines(source, setIndex),
      hint: buildHint(setObj, setKey),
      deleteIndex: del.index,
      setIndex,
      getArgIndex,
      getArgLen: getArgEnd - getArgIndex,
    });
  }

  // Emit in source order (matchAll already yields sets left-to-right, but sort
  // defensively in case a later refactor reorders the scan).
  findings.sort((a, b) => a.setIndex - b.setIndex);
  return findings;
}

function buildHint(object: string, key: string): string {
  return (
    `\`${object}.delete(${key})\` runs before \`${object}.get(${key})\`, so the value read is undefined. ` +
    `Read the value into a variable BEFORE deleting: ` +
    `\`const val = ${object}.get(${key}); ${object}.delete(${key}); ${object}.set(${key}, val);\``
  );
}

/**
 * Detect read-after-delete stores in `source`. Conservative by design: fires
 * only on `X.delete(K)` followed (with no intervening correct `X.set(K, …)`) by
 * `X.set(K, X.get(K))` on the same object and key — the exact undefined-store.
 * A `return X.get(K)` after a proper re-set, or an `X.set(K, someOtherValue)`,
 * is NOT flagged. Returns one finding per offending store, in source order.
 */
export function detectReadAfterDelete(source: string): ReadAfterDeleteFinding[] {
  return collect(source).map(({ object, key, deleteLine, setLine, hint }) => ({
    object,
    key,
    deleteLine,
    setLine,
    hint,
  }));
}

export interface StatementRepair {
  /** Full transformed source text. */
  candidate: string;
  /** Human label for logging/telemetry. */
  label: string;
  /** 1-based line of the delete that was hoisted over. */
  line: number;
}

/**
 * Deterministically repair a SINGLE unambiguous read-after-delete finding by
 * hoisting the read into a temp before the delete:
 *
 *   const __radVal = X.get(K);
 *   X.delete(K);
 *   X.set(K, __radVal);
 *
 * Returns null when there are 0 or >1 findings (ambiguous — let the oracle-guarded
 * caller skip it), or when the transform would not change the source. The temp
 * name avoids collisions: `__radVal`, then `__radVal2`, `__radVal3`, … if already
 * present in the source. Only the two touched regions change; every other
 * character/indent is preserved (slice-and-splice, like operator-mutation.ts).
 */
export function repairReadAfterDelete(source: string): StatementRepair | null {
  const findings = collect(source);
  if (findings.length !== 1) return null;
  const f = findings[0]!;

  // Pick a temp name that does not already occur in the source.
  let temp = "__radVal";
  for (let n = 2; source.includes(temp); n++) temp = `__radVal${n}`;

  // Leading whitespace of the delete's line, so the hoisted statement lands at
  // the same indentation on its own line.
  const lineStart = source.lastIndexOf("\n", f.deleteIndex - 1) + 1;
  let ip = lineStart;
  while (ip < source.length && (source[ip] === " " || source[ip] === "\t")) ip++;
  const indent = source.slice(lineStart, ip);

  const hoist = `const ${temp} = ${f.object}.get(${f.key});\n${indent}`;

  // Splice right-to-left so earlier offsets stay valid: first replace the
  // `X.get(K)` argument, then insert the hoist before the delete (delete offset
  // precedes the argument, so it is unaffected by the first splice).
  let result =
    source.slice(0, f.getArgIndex) + temp + source.slice(f.getArgIndex + f.getArgLen);
  result = result.slice(0, f.deleteIndex) + hoist + result.slice(f.deleteIndex);

  if (result === source) return null;
  return { candidate: result, label: "read-after-delete hoist", line: f.deleteLine };
}

/** 1-based line number of the character at `index` in `text`. */
function countLines(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
