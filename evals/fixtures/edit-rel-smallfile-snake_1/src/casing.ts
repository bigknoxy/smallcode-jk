// Case-conversion helpers. Each function tokenises the input into lowercase
// words (splitting on spaces, underscores, hyphens, and camelCase boundaries)
// and then recombines them in the requested casing style.

function tokenize(s: string): string[] {
  // Insert a space at lowerUpper / number boundaries so camelCase splits.
  const spaced = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  // Split on any run of separators and drop empties.
  return spaced
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

export function toCamel(s: string): string {
  const words = tokenize(s);
  if (words.length === 0) return "";
  return words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

export function toKebab(s: string): string {
  return tokenize(s).join("-");
}

export function toSnake(s: string): string {
  return tokenize(s).join("-");
}
