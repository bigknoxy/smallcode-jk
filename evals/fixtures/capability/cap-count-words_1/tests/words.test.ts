import { test, expect } from "bun:test";
import { countWords } from "../src/words";

test("counts words in simple sentence", () => {
  const result = countWords("the cat sat on the mat");
  expect(result.get("the")).toBe(2);
  expect(result.get("cat")).toBe(1);
  expect(result.get("mat")).toBe(1);
});

test("is case insensitive", () => {
  const result = countWords("Hello hello HELLO");
  expect(result.get("hello")).toBe(3);
});

test("strips trailing punctuation", () => {
  const result = countWords("hello, world!");
  expect(result.get("hello")).toBe(1);
  expect(result.get("world")).toBe(1);
});

test("handles empty string", () => {
  expect(countWords("").size).toBe(0);
});

test("handles multiple spaces", () => {
  const result = countWords("a  b   a");
  expect(result.get("a")).toBe(2);
  expect(result.get("b")).toBe(1);
});
