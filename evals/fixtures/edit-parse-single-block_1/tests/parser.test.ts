import { test, expect } from "bun:test";
import { parseEditBlock } from "../src/parser";

test("parses single search/replace block", () => {
  const response = `<<<<<<< SEARCH\nsrc/foo.ts\n=======\nold content\n>>>>>>> REPLACE\nnew content\n`;
  const result = parseEditBlock(response);
  expect(result).not.toBeNull();
  expect(result?.filePath).toBe("src/foo.ts");
  expect(result?.search).toBe("old content");
  expect(result?.replace).toBe("new content");
});
