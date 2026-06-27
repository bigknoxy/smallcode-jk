import { test, expect } from "bun:test";
import { firstN } from "../src/firstN.ts";

test("firstN returns the first n elements", () => {
  expect(firstN([1, 2, 3, 4], 2)).toEqual([1, 2]);
  expect(firstN([1, 2, 3], 5)).toEqual([1, 2, 3]);
  expect(firstN([1, 2], 0)).toEqual([]);
});
