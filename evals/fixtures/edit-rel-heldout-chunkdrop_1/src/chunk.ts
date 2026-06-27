/**
 * chunk — split an array into sub-arrays of a given size.
 * BUG: loop condition `i + size <= arr.length` drops the final partial chunk.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i + size <= arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * windows — sliding window; returns all contiguous sub-arrays of length `size`.
 * Correct helper, unrelated to chunk.
 */
export function windows<T>(arr: T[], size: number): T[][] {
  if (size <= 0 || size > arr.length) return [];
  const out: T[][] = [];
  for (let i = 0; i <= arr.length - size; i++) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * take — return the first `n` elements of an array (or the whole array if shorter).
 * Correct helper, unrelated to chunk.
 */
export function take<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}
