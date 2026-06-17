import { test, expect } from "bun:test";
import { clamp } from "../src/clamp";

test("value below min returns min", () => {
  expect(clamp(-5, 0, 10)).toBe(0);
});

test("value above max returns max", () => {
  expect(clamp(15, 0, 10)).toBe(10);
});

test("value in range returns value", () => {
  expect(clamp(5, 0, 10)).toBe(5);
});

test("value equal to min", () => {
  expect(clamp(0, 0, 10)).toBe(0);
});

test("value equal to max", () => {
  expect(clamp(10, 0, 10)).toBe(10);
});
