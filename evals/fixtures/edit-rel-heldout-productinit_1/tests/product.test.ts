import { test, expect } from "bun:test";
import { product, sum } from "../src/product.ts";

test("product of [2,3,4] is 24", () => {
  expect(product([2, 3, 4])).toBe(24);
});

test("product of empty array is 1", () => {
  expect(product([])).toBe(1);
});

test("product of [1,1,1] is 1", () => {
  expect(product([1, 1, 1])).toBe(1);
});

test("product of [5] is 5", () => {
  expect(product([5])).toBe(5);
});

test("sum still works correctly", () => {
  expect(sum([1, 2, 3])).toBe(6);
  expect(sum([])).toBe(0);
});
