/**
 * flatten — collapse one level of nesting from a 2-D array.
 */
export function flatten<T>(arr: T[][]): T[] {
  const out: T[] = [];
  for (const inner of arr) {
    for (const item of inner) {
      out.push(item);
    }
  }
  return out;
}
