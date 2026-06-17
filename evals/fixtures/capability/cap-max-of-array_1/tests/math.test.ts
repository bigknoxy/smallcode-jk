import { test, expect } from "bun:test";
import { max } from "../src/math";

test("returns max of positive numbers", () => {
  expect(max([1, 3, 2])).toBe(3);
});

test("returns max of negative numbers", () => {
  expect(max([-5, -1, -3])).toBe(-1);
});

test("returns max of single element", () => {
  expect(max([42])).toBe(42);
});

test("returns max with duplicates", () => {
  expect(max([7, 7, 7])).toBe(7);
});

test("throws on empty array", () => {
  expect(() => max([])).toThrow();
});
