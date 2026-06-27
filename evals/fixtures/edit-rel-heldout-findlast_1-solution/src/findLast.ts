// Array search utilities for finding elements from the end of a collection.

/**
 * Returns the index of the last element satisfying the predicate,
 * or -1 when none match.
 */
export function indexOfLast<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
}

/**
 * Returns the last element satisfying the predicate, or undefined when none match.
 */
export function findLast<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return arr[i];
  }
  return undefined;
}
