import { test, expect } from "bun:test";
import { parseJSONSafe } from "../src/json-safe";

test("parses valid JSON object", () => {
  const result = parseJSONSafe<{ a: number }>(`{"a":1}`);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual({ a: 1 });
  }
});

test("parses valid JSON array", () => {
  const result = parseJSONSafe<number[]>("[1,2,3]");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual([1, 2, 3]);
  }
});

test("returns error on invalid JSON", () => {
  const result = parseJSONSafe<unknown>("not json");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  }
});

test("does not throw on bad input", () => {
  expect(() => parseJSONSafe<unknown>("{bad}")).not.toThrow();
});

test("parses null", () => {
  const result = parseJSONSafe<null>("null");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toBeNull();
  }
});
