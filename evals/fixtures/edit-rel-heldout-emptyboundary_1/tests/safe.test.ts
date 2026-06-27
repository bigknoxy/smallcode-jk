import { test, expect } from "bun:test";
import { firstOr } from "../src/safe.ts";

test("firstOr returns first element when present", () => {
  expect(firstOr([1, 2, 3], 0)).toBe(1);
  expect(firstOr(["a"], "z")).toBe("a");
});

test("firstOr returns fallback when empty", () => {
  expect(firstOr([], 9)).toBe(9);
  expect(firstOr<string>([], "z")).toBe("z");
});
