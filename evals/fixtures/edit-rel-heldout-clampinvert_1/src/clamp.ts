// Numeric range utilities.

/** Returns true when n is within [lo, hi] (inclusive). */
export function inRange(n: number, lo: number, hi: number): boolean {
  return n >= lo && n <= hi;
}

/**
 * Clamps n to the interval [lo, hi].
 * Values below lo snap to lo; values above hi snap to hi.
 */
export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? hi : n > hi ? lo : n;
}
