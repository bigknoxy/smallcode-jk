import { test, expect } from "bun:test";
import { clamp } from "../src/clamp.ts";

test("clamp bounds", () => {
  expect(clamp(5, 1, 10)).toBe(5);
  expect(clamp(0, 1, 10)).toBe(1);
  expect(clamp(99, 1, 10)).toBe(10);
});
