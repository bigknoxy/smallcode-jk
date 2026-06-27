// Integer parsing helpers with fallback support.

/** Returns true if every character of s is a decimal digit (optionally leading '-'). */
export function isNumeric(s: string): boolean {
  if (s.length === 0) return false;
  return /^-?\d+$/.test(s);
}

/** Parse s as a base-10 integer, returning fallback when the result would be NaN. */
export function parseIntOr(s: string, fallback: number): number {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? fallback : n;
}
