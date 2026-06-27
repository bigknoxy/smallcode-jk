import { test, expect } from "bun:test";
import { clamp, inRange } from "../src/clamp.ts";

// inRange is correct in both buggy and fixed files — these always pass.
test("inRange: value below lo is not in range", () => {
  expect(inRange(1, 5, 10)).toBe(false);
});

test("inRange: value above hi is not in range", () => {
  expect(inRange(15, 5, 10)).toBe(false);
});

test("inRange: value at lo boundary is in range", () => {
  expect(inRange(5, 5, 10)).toBe(true);
});

test("inRange: value at hi boundary is in range", () => {
  expect(inRange(10, 5, 10)).toBe(true);
});

test("inRange: value inside range is in range", () => {
  expect(inRange(7, 5, 10)).toBe(true);
});

// clamp tests — these FAIL on the buggy file, PASS on the fix.
test("clamp: value below lo snaps to lo", () => {
  expect(clamp(1, 5, 10)).toBe(5);
});

test("clamp: value above hi snaps to hi", () => {
  expect(clamp(20, 5, 10)).toBe(10);
});

test("clamp: value already within range is returned unchanged", () => {
  expect(clamp(7, 5, 10)).toBe(7);
});

test("clamp: value equal to lo is returned as lo", () => {
  expect(clamp(5, 5, 10)).toBe(5);
});

test("clamp: value equal to hi is returned as hi", () => {
  expect(clamp(10, 5, 10)).toBe(10);
});
