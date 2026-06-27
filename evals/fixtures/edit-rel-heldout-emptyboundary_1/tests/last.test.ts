import { test, expect } from "bun:test";
import { lastOr } from "../src/last.ts";

test("lastOr returns last or fallback", () => {
  expect(lastOr([1, 2, 3], 0)).toBe(3);
  expect(lastOr([], 9)).toBe(9);
});
