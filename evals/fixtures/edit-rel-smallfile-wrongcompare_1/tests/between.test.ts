import { test, expect } from "bun:test";
import { isBetween } from "../src/between.ts";

test("isBetween interior values", () => {
  expect(isBetween(5, 1, 10)).toBe(true);
  expect(isBetween(0, 1, 10)).toBe(false);
  expect(isBetween(11, 1, 10)).toBe(false);
});

test("isBetween is inclusive of both bounds", () => {
  expect(isBetween(1, 1, 10)).toBe(true);
  expect(isBetween(10, 1, 10)).toBe(true);
});
