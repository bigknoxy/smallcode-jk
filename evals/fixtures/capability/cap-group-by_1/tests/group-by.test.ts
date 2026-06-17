import { test, expect } from "bun:test";
import { groupBy } from "../src/group-by";

test("groups by string key", () => {
  const items = [
    { type: "a", val: 1 },
    { type: "b", val: 2 },
    { type: "a", val: 3 },
  ];
  const result = groupBy(items, "type");
  expect(result["a"]).toEqual([{ type: "a", val: 1 }, { type: "a", val: 3 }]);
  expect(result["b"]).toEqual([{ type: "b", val: 2 }]);
});

test("returns empty object for empty array", () => {
  expect(groupBy([], "id" as never)).toEqual({});
});

test("groups by numeric key", () => {
  const items = [{ score: 10, name: "x" }, { score: 20, name: "y" }, { score: 10, name: "z" }];
  const result = groupBy(items, "score");
  expect(result["10"].length).toBe(2);
  expect(result["20"].length).toBe(1);
});

test("single item per group", () => {
  const items = [{ k: "a", v: 1 }, { k: "b", v: 2 }];
  const result = groupBy(items, "k");
  expect(Object.keys(result).length).toBe(2);
});
