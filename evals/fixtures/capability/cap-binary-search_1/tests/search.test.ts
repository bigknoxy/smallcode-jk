import { test, expect } from "bun:test";
import { binarySearch } from "../src/search";

test("finds element in middle", () => {
  expect(binarySearch([1, 3, 5, 7, 9], 5)).toBe(2);
});

test("finds element at start", () => {
  expect(binarySearch([1, 3, 5, 7, 9], 1)).toBe(0);
});

test("finds element at end", () => {
  expect(binarySearch([1, 3, 5, 7, 9], 9)).toBe(4);
});

test("returns -1 when not found", () => {
  expect(binarySearch([1, 3, 5, 7, 9], 4)).toBe(-1);
});

test("returns -1 for empty array", () => {
  expect(binarySearch([], 5)).toBe(-1);
});

test("finds single element", () => {
  expect(binarySearch([42], 42)).toBe(0);
});

test("single element not found", () => {
  expect(binarySearch([42], 1)).toBe(-1);
});
