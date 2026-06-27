import { test, expect } from "bun:test";
import { flatten } from "../src/flatten.ts";

test("flatten basic", () => {
  expect(flatten([[1, 2], [3, 4]])).toEqual([1, 2, 3, 4]);
});

test("flatten single inner array", () => {
  expect(flatten([[1, 2, 3]])).toEqual([1, 2, 3]);
});

test("flatten empty outer array", () => {
  expect(flatten([])).toEqual([]);
});

test("flatten with empty inner arrays", () => {
  expect(flatten([[], [1], [], [2, 3]])).toEqual([1, 2, 3]);
});

test("flatten strings", () => {
  expect(flatten([["a", "b"], ["c"]])).toEqual(["a", "b", "c"]);
});
