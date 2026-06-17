export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function parseJSONSafe<T>(s: string): ParseResult<T> {
  try {
    const value = JSON.parse(s) as T;
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
