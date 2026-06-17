import { test, expect } from "bun:test";
import { Stack } from "../src/stack";

test("isEmpty on new stack", () => {
  const s = new Stack<number>();
  expect(s.isEmpty()).toBe(true);
});

test("push and peek", () => {
  const s = new Stack<number>();
  s.push(1);
  expect(s.peek()).toBe(1);
  expect(s.isEmpty()).toBe(false);
});

test("pop returns last pushed", () => {
  const s = new Stack<number>();
  s.push(1);
  s.push(2);
  expect(s.pop()).toBe(2);
  expect(s.pop()).toBe(1);
});

test("pop on empty returns undefined", () => {
  const s = new Stack<string>();
  expect(s.pop()).toBeUndefined();
});

test("peek on empty returns undefined", () => {
  const s = new Stack<string>();
  expect(s.peek()).toBeUndefined();
});

test("isEmpty after push and pop", () => {
  const s = new Stack<number>();
  s.push(42);
  s.pop();
  expect(s.isEmpty()).toBe(true);
});
