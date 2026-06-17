/**
 * Returns the last n elements of the array.
 */
export function getLastN<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  if (n >= arr.length) return arr.slice();
  return arr.slice(arr.length - n);
}
