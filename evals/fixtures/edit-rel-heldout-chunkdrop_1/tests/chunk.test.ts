import { test, expect } from "bun:test";
import { chunk, windows, take } from "../src/chunk.ts";

// --- chunk (the buggy function) ---

test("chunk even split", () => {
  expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
});

test("chunk with trailing partial chunk", () => {
  // BUG: returns [[1,2],[3,4]] — drops [5]
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
});

test("chunk remainder of one", () => {
  expect(chunk([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
});

test("chunk size equals length", () => {
  expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
});

test("chunk size larger than array", () => {
  expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
});

test("chunk empty array", () => {
  expect(chunk([], 3)).toEqual([]);
});

// --- windows (correct helper, should always pass) ---

test("windows basic", () => {
  expect(windows([1, 2, 3, 4], 2)).toEqual([[1, 2], [2, 3], [3, 4]]);
});

test("windows size equals length", () => {
  expect(windows([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
});

test("windows empty when size exceeds length", () => {
  expect(windows([1, 2], 5)).toEqual([]);
});

// --- take (correct helper, should always pass) ---

test("take fewer than length", () => {
  expect(take([10, 20, 30, 40], 2)).toEqual([10, 20]);
});

test("take more than length returns all", () => {
  expect(take([1, 2], 10)).toEqual([1, 2]);
});

test("take zero", () => {
  expect(take([1, 2, 3], 0)).toEqual([]);
});
