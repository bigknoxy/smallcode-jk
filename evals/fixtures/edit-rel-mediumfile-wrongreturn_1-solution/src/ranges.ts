// Numeric range helpers: min, max, sum, span, and clamping utilities.
// Each function operates on a list of numbers; empty lists throw where a
// single value is required.

export function minOf(nums: number[]): number {
  if (nums.length === 0) throw new Error("minOf: empty list");
  let best = nums[0]!;
  for (const n of nums) {
    if (n < best) best = n;
  }
  return best;
}

export function maxOf(nums: number[]): number {
  if (nums.length === 0) throw new Error("maxOf: empty list");
  let best = nums[0]!;
  for (const n of nums) {
    if (n > best) best = n;
  }
  return best;
}

export function sumOf(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

export function span(nums: number[]): number {
  if (nums.length === 0) return 0;
  return maxOf(nums) - minOf(nums);
}

export function clampToRange(x: number, nums: number[]): number {
  if (nums.length === 0) return x;
  const lo = minOf(nums);
  const hi = maxOf(nums);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
