import { test, expect } from "bun:test";
import { parseEditBlocks } from "../src/parser";

test("returns empty array when no blocks present", () => {
  const result = parseEditBlocks("Just a plain text response with no edits.");
  expect(result).toEqual([]);
});
