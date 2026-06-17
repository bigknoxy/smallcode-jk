export function parseItems(raw: string): unknown[] {
  const items: unknown[] = JSON.parse(raw) as unknown[];
  return items;
}
