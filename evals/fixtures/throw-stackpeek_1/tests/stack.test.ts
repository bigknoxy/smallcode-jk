import { test, expect } from "bun:test";
import { Stack } from "../src/stack.ts";
test("peek returns the last pushed value", () => {
  const s = new Stack();
  s.push(1); s.push(2); s.push(3);
  expect(s.peek()).toBe(3);
});
test("peek is stable (no mutation)", () => {
  const s = new Stack();
  s.push(7);
  expect(s.peek()).toBe(7);
  expect(s.peek()).toBe(7);
});
