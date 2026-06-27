// True when x lies within [lo, hi], inclusive of both bounds.
export function isBetween(x: number, lo: number, hi: number): boolean {
  return x >= lo && x <= hi;
}
