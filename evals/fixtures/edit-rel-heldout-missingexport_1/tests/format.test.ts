import { test, expect } from "bun:test";
import { pluralize, capitalize } from "../src/format.ts";

test("pluralize singular vs plural", () => {
  expect(pluralize("cat", 1)).toBe("cat");
  expect(pluralize("cat", 3)).toBe("cats");
  expect(pluralize("dog", 0)).toBe("dogs");
});

test("capitalize first letter", () => {
  expect(capitalize("hello")).toBe("Hello");
  expect(capitalize("")).toBe("");
});
