/**
 * Returns a new array with duplicate values removed, preserving insertion order.
 * Uses a Set internally for O(n) performance.
 */
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
