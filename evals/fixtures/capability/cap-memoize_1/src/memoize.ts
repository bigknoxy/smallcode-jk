export function memoize<T>(fn: (...args: number[]) => T): (...args: number[]) => T {
  const cache = new Map<string, T>();
  return (...args: number[]): T => {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key) as T;
    }
    const result = fn(...args);
    cache.set(key, result);
    return result;
  };
}
