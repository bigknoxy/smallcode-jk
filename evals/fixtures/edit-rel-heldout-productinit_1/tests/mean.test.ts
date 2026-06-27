import { test, expect } from "bun:test";
import { mean } from "../src/mean.ts";

test("mean of [1,2,3] is 2", () => {
  expect(mean([1, 2, 3])).toBe(2);
});

test("mean of empty array is 0", () => {
  expect(mean([])).toBe(0);
});

test("mean of [10] is 10", () => {
  expect(mean([10])).toBe(10);
});

test("mean of [1,2,3,4] is 2.5", () => {
  expect(mean([1, 2, 3, 4])).toBe(2.5);
});
