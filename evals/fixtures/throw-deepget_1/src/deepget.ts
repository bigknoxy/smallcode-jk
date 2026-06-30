/** Resolve a dotted path against an object; return undefined if any step is missing. */
export function deepGet(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce((o: any, k) => o[k], obj);
}
