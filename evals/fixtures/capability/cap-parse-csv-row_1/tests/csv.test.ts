import { test, expect } from "bun:test";
import { parseCsvRow } from "../src/csv";

test("parses simple row", () => {
  expect(parseCsvRow("a,b,c")).toEqual(["a", "b", "c"]);
});

test("handles quoted field with comma", () => {
  expect(parseCsvRow('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
});

test("handles multiple quoted fields", () => {
  expect(parseCsvRow('"hello,world","foo,bar"')).toEqual(["hello,world", "foo,bar"]);
});

test("handles empty fields", () => {
  expect(parseCsvRow("a,,c")).toEqual(["a", "", "c"]);
});

test("handles single field", () => {
  expect(parseCsvRow("only")).toEqual(["only"]);
});

test("handles quoted field at end", () => {
  expect(parseCsvRow('a,b,"c,d"')).toEqual(["a", "b", "c,d"]);
});
