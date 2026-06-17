/**
 * Returns true if the string is a palindrome.
 * Case-insensitive, ignores non-alphanumeric characters.
 */
export function isPalindrome(s: string): boolean {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === cleaned.split("").reverse().join("");
}
