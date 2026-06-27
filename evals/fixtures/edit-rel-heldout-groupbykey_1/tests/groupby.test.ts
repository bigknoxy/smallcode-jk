import { test, expect } from "bun:test";
import { groupBy, countBy } from "../src/groupby.ts";

type Person = { name: string; dept: string };

const people: Person[] = [
  { name: "Alice", dept: "eng" },
  { name: "Bob",   dept: "eng" },
  { name: "Carol", dept: "hr" },
  { name: "Dave",  dept: "hr" },
  { name: "Eve",   dept: "eng" },
];

test("groupBy produces correct bucket keys", () => {
  const result = groupBy(people, (p) => p.dept);
  // Should have exactly two keys: "eng" and "hr"
  expect(Object.keys(result).sort()).toEqual(["eng", "hr"]);
});

test("groupBy puts items into the right buckets", () => {
  const result = groupBy(people, (p) => p.dept);
  expect(result["eng"]?.map((p) => p.name)).toEqual(["Alice", "Bob", "Eve"]);
  expect(result["hr"]?.map((p) => p.name)).toEqual(["Carol", "Dave"]);
});

test("groupBy on empty array returns empty record", () => {
  const result = groupBy([] as Person[], (p) => p.dept);
  expect(result).toEqual({});
});

test("groupBy with single-item array returns one bucket", () => {
  const result = groupBy([{ name: "X", dept: "qa" }], (p) => p.dept);
  expect(Object.keys(result)).toEqual(["qa"]);
  expect(result["qa"]?.length).toBe(1);
});

test("countBy (correct fn) still works after groupBy fix", () => {
  const result = countBy(people, (p) => p.dept);
  expect(result["eng"]).toBe(3);
  expect(result["hr"]).toBe(2);
});
