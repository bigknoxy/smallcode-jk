// Integer parsing helpers with fallback support.

/** Returns true if every character of s is a decimal digit (optionally leading '-'). */
export function isNumeric(s: string): boolean {
  if (s.length === 0) return false;
  return /^-?\d+$/.test(s);
}

/**
 * Parse s as a base-10 integer.
 * BUG: returns parseInt(s, 10) directly — non-numeric input yields NaN instead of fallback.
 */
export function parseIntOr(s: string, fallback: number): number {
  return parseInt(s, 10);
}
