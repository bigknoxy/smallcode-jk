// Return the first n elements of an array, in order. Clamps to the array length.
export function firstN<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  return arr.slice(0, Math.max(0, n));
}
