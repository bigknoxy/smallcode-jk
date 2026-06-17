import { test, expect } from "bun:test";
import { unique } from "../src/unique";

test("removes duplicate numbers", () => {
  expect(unique([1, 2, 2, 3, 1])).toEqual([1, 2, 3]);
});

test("removes duplicate strings", () => {
  expect(unique(["a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
});

test("empty array returns empty", () => {
  expect(unique([])).toEqual([]);
});

test("no duplicates unchanged", () => {
  expect(unique([1, 2, 3])).toEqual([1, 2, 3]);
});

test("preserves insertion order", () => {
  expect(unique([3, 1, 2, 1, 3])).toEqual([3, 1, 2]);
});
