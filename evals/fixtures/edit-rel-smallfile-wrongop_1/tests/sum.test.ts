import { test, expect } from "bun:test";
import { sum } from "../src/sum.ts";

test("sum of integers", () => {
  expect(sum([1, 2, 3])).toBe(6);
  expect(sum([])).toBe(0);
});
