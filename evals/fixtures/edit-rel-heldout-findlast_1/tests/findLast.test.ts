import { test, expect } from "bun:test";
import { findLast, indexOfLast } from "../src/findLast.ts";

test("findLast returns the LAST matching element when there are two matches", () => {
  // Both 2 and 4 are even; the last even element is 4.
  expect(findLast([1, 2, 3, 4, 5], (x) => x % 2 === 0)).toBe(4);
});

test("findLast returns the last match when multiple satisfy the predicate", () => {
  // Both "cat" and "car" start with "c"; last one is "car".
  expect(findLast(["dog", "cat", "bird", "car"], (s) => s.startsWith("c"))).toBe("car");
});

test("findLast returns undefined when no element matches", () => {
  expect(findLast([1, 3, 5], (x) => x % 2 === 0)).toBeUndefined();
  expect(findLast<number>([], (x) => x > 0)).toBeUndefined();
});

test("findLast returns the single match when only one element matches", () => {
  expect(findLast([1, 2, 3], (x) => x === 3)).toBe(3);
});

test("indexOfLast returns index of last match", () => {
  // Elements 2 (index 1) and 4 (index 3) are even; last even is at index 3.
  expect(indexOfLast([1, 2, 3, 4, 5], (x) => x % 2 === 0)).toBe(3);
});

test("indexOfLast returns -1 when no match", () => {
  expect(indexOfLast([1, 3, 5], (x) => x % 2 === 0)).toBe(-1);
});
