import { test, expect } from "bun:test";
import { memoize } from "../src/memoize";

test("returns correct result", () => {
  const add = memoize((a: number, b: number) => a + b);
  expect(add(2, 3)).toBe(5);
});

test("caches result — original only called once", () => {
  let callCount = 0;
  const fn = memoize((x: number) => { callCount++; return x * 2; });
  fn(5);
  fn(5);
  fn(5);
  expect(callCount).toBe(1);
});

test("different args call function again", () => {
  let callCount = 0;
  const fn = memoize((x: number) => { callCount++; return x * 2; });
  fn(1);
  fn(2);
  expect(callCount).toBe(2);
});

test("caches multiple distinct args", () => {
  let callCount = 0;
  const fn = memoize((a: number, b: number) => { callCount++; return a + b; });
  fn(1, 2);
  fn(1, 2);
  fn(3, 4);
  fn(3, 4);
  expect(callCount).toBe(2);
});
