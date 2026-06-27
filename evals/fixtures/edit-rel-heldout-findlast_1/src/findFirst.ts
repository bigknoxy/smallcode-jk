// Array search utilities for finding elements from the beginning of a collection.

/**
 * Returns the first element satisfying the predicate, or undefined when none match.
 */
export function findFirst<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  for (const x of arr) {
    if (pred(x)) return x;
  }
  return undefined;
}
