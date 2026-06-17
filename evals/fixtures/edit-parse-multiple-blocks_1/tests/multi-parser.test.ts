import { test, expect } from "bun:test";
import { parseEditBlocks } from "../src/multi-parser";

test("parses two blocks", () => {
  const response = `File: src/a.ts\n<<<<<<< SEARCH\nold_a\n=======\nnew_a\n>>>>>>>`
    + `\n\nFile: src/b.ts\n<<<<<<< SEARCH\nold_b\n=======\nnew_b\n>>>>>>>`;
  const blocks = parseEditBlocks(response);
  expect(blocks.length).toBe(2);
});
