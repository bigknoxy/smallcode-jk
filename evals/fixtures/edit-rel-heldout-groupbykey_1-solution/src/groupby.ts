// Collection grouping utilities.

/**
 * Group items into buckets by the string returned by `key`.
 */
export function groupBy<T>(items: T[], key: (x: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item); // FIX: use key(item) instead of String(item)
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
