// String formatting helpers.

export function pluralize(word: string, n: number): string {
  return n === 1 ? word : word + "s";
}

export function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
