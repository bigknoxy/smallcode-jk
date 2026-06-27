// Return the last element, or the fallback when empty.
export function lastOr<T>(arr: T[], fallback: T): T {
  return arr.length > 0 ? arr[arr.length - 1]! : fallback;
}
