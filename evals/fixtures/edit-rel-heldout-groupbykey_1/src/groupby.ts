// Collection grouping utilities.

/**
 * Group items into buckets by the string returned by `key`.
 * BUG: uses String(item) instead of key(item), so every item lands under
 * a stringified-object key rather than the intended bucket.
 */
export function groupBy<T>(items: T[], key: (x: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = String(item); // BUG: should be key(item)
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
}

/**
 * Count how many items fall into each bucket produced by `key`.
 * Correct implementation.
 */
export function countBy<T>(items: T[], key: (x: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
