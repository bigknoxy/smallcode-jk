export function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const k = String(item[key]);
    if (!result[k]) {
      result[k] = [];
    }
    result[k].push(item);
  }
  return result;
}
