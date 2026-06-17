import { test, expect } from "bun:test";
import { removeDuplicates } from "../src/dedup";

test("removes duplicate numbers", () => {
  expect(removeDuplicates([1, 2, 2, 3, 1])).toEqual([1, 2, 3]);
});

test("preserves order of first occurrence", () => {
  expect(removeDuplicates([3, 1, 2, 1, 3])).toEqual([3, 1, 2]);
});

test("handles empty array", () => {
  expect(removeDuplicates([])).toEqual([]);
});

test("handles array with no duplicates", () => {
  expect(removeDuplicates([1, 2, 3])).toEqual([1, 2, 3]);
});

test("works with strings", () => {
  expect(removeDuplicates(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
});

test("handles all same elements", () => {
  expect(removeDuplicates([5, 5, 5, 5])).toEqual([5]);
});
