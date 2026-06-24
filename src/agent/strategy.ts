/**
 * Strategy hints for redraft turns.
 *
 * Rotated through when a stall is detected so each redraft attempt gets a
 * different nudge. Cycling means we never repeat the same hint twice in a row,
 * giving the model genuinely different starting angles.
 */

const STRATEGY_HINTS: readonly string[] = [
  "use a set/dedup explicitly",
  "step through each provided example by hand first",
  "handle edge cases (empty, negative, boundary) before the main case",
];

/**
 * Return a strategy hint for the nth redraft (0-indexed).
 * Cycles through STRATEGY_HINTS modulo the list length.
 */
export function rotateStrategy(n: number): string {
  return STRATEGY_HINTS[n % STRATEGY_HINTS.length] ?? STRATEGY_HINTS[0] ?? "";
}
