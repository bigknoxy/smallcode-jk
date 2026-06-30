/** Uppercase initial of each word, e.g. "John Doe" -> "JD". */
export function initials(name: string): string {
  return name
    .trim()
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase())
    .join("");
}
