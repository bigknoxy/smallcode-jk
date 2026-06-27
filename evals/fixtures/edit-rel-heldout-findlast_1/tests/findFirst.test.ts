import { test, expect } from "bun:test";
import { findFirst } from "../src/findFirst.ts";

test("findFirst returns the first matching element", () => {
  expect(findFirst([1, 2, 3, 4], (x) => x % 2 === 0)).toBe(2);
});

test("findFirst returns undefined when no element matches", () => {
  expect(findFirst([1, 3, 5], (x) => x % 2 === 0)).toBeUndefined();
  expect(findFirst<number>([], (x) => x > 0)).toBeUndefined();
});

test("findFirst returns the first of multiple matches", () => {
  expect(findFirst(["apple", "banana", "avocado"], (s) => s.startsWith("a"))).toBe("apple");
});
