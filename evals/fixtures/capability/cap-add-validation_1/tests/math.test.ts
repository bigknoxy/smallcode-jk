import { test, expect } from "bun:test";
import { divide } from "../src/math";

test("divides two positive numbers", () => {
  expect(divide(10, 2)).toBe(5);
});

test("divides with negative", () => {
  expect(divide(-6, 3)).toBe(-2);
});

test("divides to decimal", () => {
  expect(divide(1, 4)).toBe(0.25);
});

test("throws when divisor is zero", () => {
  expect(() => divide(5, 0)).toThrow();
});

test("throws when both are zero", () => {
  expect(() => divide(0, 0)).toThrow();
});
