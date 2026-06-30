/** Uppercase initial of each word, e.g. "John Doe" -> "JD". */
export function initials(name: string): string {
  return name
    .trim()
    .split(" ")
    .map((w) => w[0].toUpperCase())
    .join("");
}
