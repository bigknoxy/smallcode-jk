import { test, expect } from "bun:test";
import {
  renderTable,
  renderTableWith,
  columnWidths,
  padCell,
  renderRow,
  separatorLine,
  normalizeRows,
  countColumns,
} from "../src/table.ts";

test("columnWidths takes max per column", () => {
  expect(
    columnWidths([
      ["a", "bb"],
      ["ccc", "d"],
    ]),
  ).toEqual([3, 2]);
});

test("columnWidths handles ragged rows", () => {
  expect(
    columnWidths([
      ["aa", "b", "cccc"],
      ["x"],
    ]),
  ).toEqual([2, 1, 4]);
});

test("padCell left and right align", () => {
  expect(padCell("ab", 5, "left")).toBe("ab   ");
  expect(padCell("ab", 5, "right")).toBe("   ab");
  expect(padCell("toolong", 3, "left")).toBe("toolong");
});

test("separatorLine matches column widths plus padding", () => {
  expect(separatorLine([3, 2])).toBe("+-----+----+");
});

test("renderRow pads and delimits cells", () => {
  expect(renderRow(["a", "bb"], [3, 2], "left")).toBe("| a   | bb |");
});

test("renderRow fills missing cells", () => {
  expect(renderRow(["a"], [2, 2], "left")).toBe("| a  |    |");
});

test("renderTable produces a full aligned table", () => {
  const out = renderTable([
    ["name", "age"],
    ["alice", "30"],
    ["bob", "5"],
  ]);
  expect(out).toBe(
    [
      "+-------+-----+",
      "| name  | age |",
      "+-------+-----+",
      "| alice | 30  |",
      "| bob   | 5   |",
      "+-------+-----+",
    ].join("\n"),
  );
});

test("renderTable on empty input is empty string", () => {
  expect(renderTable([])).toBe("");
});

test("countColumns and normalizeRows rectangularise input", () => {
  const rows = [["a", "b"], ["c"]];
  expect(countColumns(rows)).toBe(2);
  expect(normalizeRows(rows, 2)).toEqual([["a", "b"], ["c", ""]]);
});

test("renderTableWith honours per-column alignment", () => {
  const out = renderTableWith(
    [
      ["name", "age"],
      ["alice", "30"],
    ],
    ["left", "right"],
  );
  expect(out).toBe(
    [
      "+-------+-----+",
      "| name  | age |",
      "+-------+-----+",
      "| alice |  30 |",
      "+-------+-----+",
    ].join("\n"),
  );
});
