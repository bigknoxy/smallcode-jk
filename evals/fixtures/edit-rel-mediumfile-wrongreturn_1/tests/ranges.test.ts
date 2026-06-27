import { test, expect } from "bun:test";
import { minOf, maxOf, sumOf, span, clampToRange } from "../src/ranges.ts";

test("minOf returns the smallest", () => {
  expect(minOf([3, 1, 2])).toBe(1);
  expect(minOf([-5, 0, 5])).toBe(-5);
});

test("maxOf returns the largest", () => {
  expect(maxOf([3, 1, 2])).toBe(3);
  expect(maxOf([-5, 0, 5])).toBe(5);
});

test("sumOf adds all", () => {
  expect(sumOf([1, 2, 3])).toBe(6);
});

test("span is max minus min", () => {
  expect(span([3, 1, 7])).toBe(6);
});

test("clampToRange clamps to the data extremes", () => {
  expect(clampToRange(10, [1, 2, 3])).toBe(3);
  expect(clampToRange(0, [1, 2, 3])).toBe(1);
  expect(clampToRange(2, [1, 2, 3])).toBe(2);
});
