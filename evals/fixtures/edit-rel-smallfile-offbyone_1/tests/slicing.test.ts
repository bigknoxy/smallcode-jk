import { test, expect } from "bun:test";
import { lastN } from "../src/slicing.ts";

test("lastN returns the last n elements", () => {
  expect(lastN([1, 2, 3, 4], 2)).toEqual([3, 4]);
  expect(lastN([1, 2, 3], 1)).toEqual([3]);
});

test("lastN clamps to array length", () => {
  expect(lastN([1, 2, 3], 3)).toEqual([1, 2, 3]);
  expect(lastN([1, 2, 3], 5)).toEqual([1, 2, 3]);
});

test("lastN handles empty and non-positive n", () => {
  expect(lastN([], 2)).toEqual([]);
  expect(lastN([1, 2], 0)).toEqual([]);
});
