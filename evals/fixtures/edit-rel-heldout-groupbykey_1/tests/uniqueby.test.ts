import { test, expect } from "bun:test";
import { uniqueBy } from "../src/uniqueby.ts";

test("uniqueBy returns first occurrence of each key", () => {
  const items = [
    { id: 1, tag: "a" },
    { id: 2, tag: "b" },
    { id: 3, tag: "a" },
    { id: 4, tag: "c" },
  ];
  const result = uniqueBy(items, (x) => x.tag);
  expect(result.map((x) => x.id)).toEqual([1, 2, 4]);
});

test("uniqueBy on empty array returns empty array", () => {
  expect(uniqueBy([], (x: string) => x)).toEqual([]);
});

test("uniqueBy with all-unique keys returns all items", () => {
  const items = ["alpha", "beta", "gamma"];
  expect(uniqueBy(items, (s) => s)).toEqual(["alpha", "beta", "gamma"]);
});

test("uniqueBy with all-same keys returns only the first", () => {
  const items = [10, 20, 30];
  const result = uniqueBy(items, () => "same");
  expect(result).toEqual([10]);
});
