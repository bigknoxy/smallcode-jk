/**
 * Returns a new array with numbers sorted in ascending order.
 * Does not mutate the input array.
 */
export function sortNumbers(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}
