import { test, expect } from "bun:test";
import { trimWhitespace } from "../src/string-utils";

test("trims spaces", () => {
  expect(trimWhitespace("  hello  ")).toBe("hello");
});

test("trims tabs and newlines", () => {
  expect(trimWhitespace("\t\nhello\n\t")).toBe("hello");
});

test("empty string stays empty", () => {
  expect(trimWhitespace("")).toBe("");
});

test("no whitespace unchanged", () => {
  expect(trimWhitespace("hello")).toBe("hello");
});

test("only whitespace becomes empty", () => {
  expect(trimWhitespace("   ")).toBe("");
});
