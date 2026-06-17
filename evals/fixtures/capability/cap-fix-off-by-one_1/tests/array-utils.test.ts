import { test, expect } from "bun:test";
import { getLastN } from "../src/array-utils";

test("returns last 3 elements", () => {
  expect(getLastN([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
});

test("returns last 1 element", () => {
  expect(getLastN([10, 20, 30], 1)).toEqual([30]);
});

test("returns all when n >= length", () => {
  expect(getLastN([1, 2], 5)).toEqual([1, 2]);
});

test("returns empty when n is 0", () => {
  expect(getLastN([1, 2, 3], 0)).toEqual([]);
});

test("returns last 2 of 4", () => {
  expect(getLastN(["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
});
