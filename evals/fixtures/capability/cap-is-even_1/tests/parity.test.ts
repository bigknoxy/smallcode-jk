import { test, expect } from "bun:test";
import { isEven } from "../src/parity";

test("zero is even", () => {
  expect(isEven(0)).toBe(true);
});

test("positive even", () => {
  expect(isEven(4)).toBe(true);
});

test("positive odd", () => {
  expect(isEven(7)).toBe(false);
});

test("negative even", () => {
  expect(isEven(-2)).toBe(true);
});

test("negative odd", () => {
  expect(isEven(-3)).toBe(false);
});
