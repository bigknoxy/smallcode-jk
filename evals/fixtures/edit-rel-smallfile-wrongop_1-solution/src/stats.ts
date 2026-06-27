// Arithmetic mean of a list of numbers. Empty list yields 0.
export function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  const total = nums.reduce((a, b) => a + b, 0);
  return total / nums.length;
}
