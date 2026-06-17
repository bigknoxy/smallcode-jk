/**
 * Clamps n to the range [min, max].
 * Returns min if n < min, max if n > max, otherwise n.
 */
export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
