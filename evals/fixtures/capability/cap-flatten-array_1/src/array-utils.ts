export function flatten(arr: (number | number[])[]): number[] {
  const result: number[] = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      for (const n of item) {
        result.push(n);
      }
    } else {
      result.push(item);
    }
  }
  return result;
}
