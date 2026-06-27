import { test, expect } from "bun:test";
import { lerp } from "../src/lerp.ts";

test("lerp: t=0 returns a", () => {
  expect(lerp(0, 100, 0)).toBe(0);
});

test("lerp: t=1 returns b", () => {
  expect(lerp(0, 100, 1)).toBe(100);
});

test("lerp: t=0.5 returns midpoint", () => {
  expect(lerp(0, 100, 0.5)).toBe(50);
});

test("lerp: t=0.25 returns quarter-way value", () => {
  expect(lerp(0, 100, 0.25)).toBe(25);
});

test("lerp: works with negative values", () => {
  expect(lerp(-10, 10, 0.5)).toBe(0);
});
