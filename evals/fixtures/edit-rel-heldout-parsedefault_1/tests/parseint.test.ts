import { test, expect } from "bun:test";
import { parseIntOr } from "../src/parseint.ts";

test("parseIntOr returns parsed integer for valid input", () => {
  expect(parseIntOr("42", 0)).toBe(42);
  expect(parseIntOr("-7", 0)).toBe(-7);
  expect(parseIntOr("0", 99)).toBe(0);
});

test("parseIntOr returns fallback for non-numeric input", () => {
  expect(parseIntOr("x", 5)).toBe(5);
  expect(parseIntOr("abc", -1)).toBe(-1);
});

test("parseIntOr returns fallback for empty string", () => {
  expect(parseIntOr("", 10)).toBe(10);
});
