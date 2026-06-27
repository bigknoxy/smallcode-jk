import { test, expect } from "bun:test";
import { clampInt } from "../src/clampint.ts";

test("clampInt returns value within range unchanged", () => {
  expect(clampInt(5, 1, 10)).toBe(5);
  expect(clampInt(1, 1, 10)).toBe(1);
  expect(clampInt(10, 1, 10)).toBe(10);
});

test("clampInt clamps below lo", () => {
  expect(clampInt(-3, 0, 100)).toBe(0);
  expect(clampInt(0, 5, 20)).toBe(5);
});

test("clampInt clamps above hi", () => {
  expect(clampInt(200, 0, 100)).toBe(100);
  expect(clampInt(21, 5, 20)).toBe(20);
});
