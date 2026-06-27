// Return the last n elements of an array, in order. Clamps to the array length.
export function lastN<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  return arr.slice(Math.max(0, arr.length - n + 1));
}
