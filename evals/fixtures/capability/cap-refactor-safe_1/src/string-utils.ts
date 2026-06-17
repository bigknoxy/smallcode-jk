/**
 * Removes leading and trailing whitespace from a string.
 * Wrapper around String.prototype.trim.
 */
export function trimWhitespace(s: string): string {
  const trimmed = s.trim();
  return trimmed;
}
