// Integer clamping helpers.

/** Clamp n to the inclusive range [lo, hi]. */
export function clampInt(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
