export function makeCounters(n: number): (() => number)[] {
  const fns: (() => number)[] = [];
  for (let i = 0; i < n; i++) {
    fns.push(() => i);
  }
  return fns;
}
