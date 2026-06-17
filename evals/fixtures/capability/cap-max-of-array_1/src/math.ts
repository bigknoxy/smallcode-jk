export function max(arr: number[]): number {
  if (arr.length === 0) throw new Error("max: array must not be empty");
  return arr.reduce((a, b) => (b > a ? b : a));
}
