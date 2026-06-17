import { test, expect } from "bun:test";
import { add } from "../src/math";

test("add two positive numbers", () => {
  expect(add(1, 2)).toBe(3);
});

test("add with zero", () => {
  expect(add(5, 0)).toBe(5);
});

test("add negative numbers", () => {
  expect(add(-3, -4)).toBe(-7);
});

test("add positive and negative", () => {
  expect(add(10, -3)).toBe(7);
});
