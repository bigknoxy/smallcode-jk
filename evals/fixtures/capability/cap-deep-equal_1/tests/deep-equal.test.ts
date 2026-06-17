import { test, expect } from "bun:test";
import { deepEqual } from "../src/deep-equal";

test("primitive equality", () => {
  expect(deepEqual(1, 1)).toBe(true);
  expect(deepEqual("a", "a")).toBe(true);
  expect(deepEqual(1, 2)).toBe(false);
});

test("null and undefined", () => {
  expect(deepEqual(null, null)).toBe(true);
  expect(deepEqual(undefined, undefined)).toBe(true);
  expect(deepEqual(null, undefined)).toBe(false);
});

test("flat object equality", () => {
  expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
});

test("nested object equality", () => {
  expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
  expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
});

test("array equality", () => {
  expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
});

test("nested arrays", () => {
  expect(deepEqual([[1, 2], [3]], [[1, 2], [3]])).toBe(true);
  expect(deepEqual([[1, 2], [3]], [[1, 2], [4]])).toBe(false);
});

test("different types", () => {
  expect(deepEqual([], {})).toBe(false);
  expect(deepEqual(1, "1")).toBe(false);
});

test("object missing key", () => {
  expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
});
