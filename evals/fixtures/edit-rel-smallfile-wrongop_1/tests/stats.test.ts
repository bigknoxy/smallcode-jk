import { test, expect } from "bun:test";
import { mean } from "../src/stats.ts";

test("mean of integers", () => {
  expect(mean([2, 4, 6])).toBe(4);
  expect(mean([5])).toBe(5);
});

test("mean with fractional result", () => {
  expect(mean([1, 2, 3, 4])).toBe(2.5);
});

test("mean of empty list is 0", () => {
  expect(mean([])).toBe(0);
});
