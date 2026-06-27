// Linear interpolation utilities.

/**
 * Linearly interpolates between a and b by factor t.
 * t=0 returns a, t=1 returns b, t=0.5 returns the midpoint.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
