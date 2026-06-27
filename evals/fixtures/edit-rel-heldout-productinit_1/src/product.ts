/**
 * Returns the sum of all numbers in the array.
 * Returns 0 for an empty array.
 */
export function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

/**
 * Returns the product of all numbers in the array.
 * Returns 1 for an empty array.
 */
export function product(nums: number[]): number {
  return nums.reduce((a, b) => a * b, 0);
}
