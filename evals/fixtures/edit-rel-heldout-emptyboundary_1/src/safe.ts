// Safe array access helpers with fallbacks for empty inputs.
export function firstOr<T>(arr: T[], fallback: T): T {
  return arr[0]!;
}
