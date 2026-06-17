import { test, expect } from "bun:test";
import { flatten } from "../src/array-utils";

test("flattens simple nested arrays", () => {
  expect(flatten([1, [2, 3], 4])).toEqual([1, 2, 3, 4]);
});

test("handles all scalars", () => {
  expect(flatten([1, 2, 3])).toEqual([1, 2, 3]);
});

test("handles empty array", () => {
  expect(flatten([])).toEqual([]);
});

test("handles array of arrays", () => {
  expect(flatten([[1, 2], [3, 4]])).toEqual([1, 2, 3, 4]);
});

test("handles empty inner arrays", () => {
  expect(flatten([1, [], 2])).toEqual([1, 2]);
});
