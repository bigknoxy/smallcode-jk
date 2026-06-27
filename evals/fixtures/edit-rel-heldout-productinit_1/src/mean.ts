/**
 * Returns the arithmetic mean of all numbers in the array.
 * Returns 0 for an empty array.
 */
export function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
