import { test, expect } from "bun:test";
import { sortNumbers } from "../src/sort";

test("sorts numbers ascending", () => {
  expect(sortNumbers([3, 1, 4, 1, 5, 9, 2, 6])).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
});

test("does not mutate input", () => {
  const arr = [3, 1, 2];
  sortNumbers(arr);
  expect(arr).toEqual([3, 1, 2]);
});

test("handles empty array", () => {
  expect(sortNumbers([])).toEqual([]);
});

test("handles single element", () => {
  expect(sortNumbers([42])).toEqual([42]);
});

test("handles already sorted", () => {
  expect(sortNumbers([1, 2, 3])).toEqual([1, 2, 3]);
});

test("handles negative numbers", () => {
  expect(sortNumbers([-3, 0, -1, 2])).toEqual([-3, -1, 0, 2]);
});
