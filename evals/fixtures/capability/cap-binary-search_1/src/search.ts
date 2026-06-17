/**
 * Binary search on a sorted array.
 * Returns the index of target, or -1 if not found.
 */
export function binarySearch(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] === target) return mid;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
