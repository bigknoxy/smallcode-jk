/**
 * Count word frequency in text.
 * Words are lowercase, split on whitespace, punctuation stripped from edges.
 * Returns a Map<string, number>.
 */
export function countWords(text: string): Map<string, number> {
  const map = new Map<string, number>();
  if (!text.trim()) return map;
  const words = text.trim().split(/\s+/);
  for (const raw of words) {
    const word = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (!word) continue;
    map.set(word, (map.get(word) ?? 0) + 1);
  }
  return map;
}
