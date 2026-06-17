import { describe, expect, test } from "bun:test";
import { parse } from "../src/edit/parser.ts";

// ---------------------------------------------------------------------------
// Helper to build a standard search/replace block string
// ---------------------------------------------------------------------------
function srBlock(
  path: string,
  search: string,
  replace: string,
  {
    searchTag = "<<<<<<< SEARCH",
    sep = "=======",
    replaceTag = ">>>>>>> REPLACE",
  }: { searchTag?: string; sep?: string; replaceTag?: string } = {},
): string {
  return `${path}\n${searchTag}\n${search}\n${sep}\n${replace}\n${replaceTag}`;
}

// ---------------------------------------------------------------------------
// 1. Parses single search/replace block correctly
// ---------------------------------------------------------------------------
describe("search/replace format", () => {
  test("parses single block correctly", () => {
    const raw = srBlock("src/foo/bar.ts", "old code here", "new code here");
    const result = parse(raw);

    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0]!;
    expect(block.filePath).toBe("src/foo/bar.ts");
    expect(block.search).toBe("old code here");
    expect(block.replace).toBe("new code here");
    expect(block.format).toBe("search-replace");
  });

  // ---------------------------------------------------------------------------
  // 2. Parses multiple blocks in one response
  // ---------------------------------------------------------------------------
  test("parses multiple blocks in one response", () => {
    const raw = [srBlock("src/a.ts", "aOld", "aNew"), "", srBlock("src/b.ts", "bOld", "bNew")].join(
      "\n",
    );

    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.filePath).toBe("src/a.ts");
    expect(result.blocks[1]?.filePath).toBe("src/b.ts");
  });

  // ---------------------------------------------------------------------------
  // 3. Tolerates <<<<<<<SEARCH (no space)
  // ---------------------------------------------------------------------------
  test("tolerates <<<<<<<SEARCH (no space)", () => {
    const raw = srBlock("src/foo.ts", "old", "new", { searchTag: "<<<<<<<SEARCH" });
    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.search).toBe("old");
  });

  // ---------------------------------------------------------------------------
  // 4. Tolerates ====== (6 =) as separator
  // ---------------------------------------------------------------------------
  test("tolerates 6-equals separator", () => {
    const raw = srBlock("src/foo.ts", "old", "new", { sep: "======" });
    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 5. Tolerates >>>>>>> replace (lowercase)
  // ---------------------------------------------------------------------------
  test("tolerates lowercase >>>>>>> replace tag", () => {
    const raw = srBlock("src/foo.ts", "old", "new", { replaceTag: ">>>>>>> replace" });
    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 6. Preserves exact whitespace in SEARCH and REPLACE content
  // ---------------------------------------------------------------------------
  test("preserves exact whitespace in content", () => {
    const search = "  indented\n\n  also indented\n";
    const replace = "\tTabbed\n  mixed\n";
    const raw = `src/ws.ts\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
    // The parser joins lines with \n, so trailing \n in search/replace adds an extra line
    expect(result.blocks[0]?.search).toBe(search);
    expect(result.blocks[0]?.replace).toBe(replace);
  });

  // ---------------------------------------------------------------------------
  // 7. Empty SEARCH block parsed as empty string (new file)
  // ---------------------------------------------------------------------------
  test("empty SEARCH block is valid and parsed as empty string", () => {
    const raw = `src/new.ts\n<<<<<<< SEARCH\n=======\ncreated content\n>>>>>>> REPLACE`;
    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.search).toBe("");
    expect(result.blocks[0]?.replace).toBe("created content");
  });

  // ---------------------------------------------------------------------------
  // 13. Leading ./ stripped from path
  // ---------------------------------------------------------------------------
  test("strips leading ./ from file path", () => {
    const raw = srBlock("./src/stripped.ts", "a", "b");
    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks[0]?.filePath).toBe("src/stripped.ts");
  });

  // ---------------------------------------------------------------------------
  // 14. Mixed content (prose + edit block) — block extracted, prose ignored
  // ---------------------------------------------------------------------------
  test("extracts block from mixed prose content", () => {
    const raw = `Here is the change I recommend making to fix the bug:

src/utils.ts
<<<<<<< SEARCH
return false;
=======
return true;
>>>>>>> REPLACE

That should resolve the issue you described.`;

    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.filePath).toBe("src/utils.ts");
    expect(result.blocks[0]?.search).toBe("return false;");
    expect(result.blocks[0]?.replace).toBe("return true;");
  });
});

// ---------------------------------------------------------------------------
// JSON format tests
// ---------------------------------------------------------------------------
describe("JSON format", () => {
  // 8. Single edit object parsed
  test("parses single JSON edit object", () => {
    const raw = JSON.stringify({ type: "edit", file: "src/foo.ts", search: "old", replace: "new" });
    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0]!;
    expect(block.filePath).toBe("src/foo.ts");
    expect(block.search).toBe("old");
    expect(block.replace).toBe("new");
    expect(block.format).toBe("json");
  });

  // 9. Array of edits parsed
  test("parses JSON array of edit objects", () => {
    const raw = JSON.stringify([
      { type: "edit", file: "src/a.ts", search: "x", replace: "y" },
      { type: "edit", file: "src/b.ts", search: "p", replace: "q" },
    ]);
    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.filePath).toBe("src/a.ts");
    expect(result.blocks[1]?.filePath).toBe("src/b.ts");
  });

  // 10. JSON in markdown fence parsed
  test("parses JSON edit from markdown fence", () => {
    const obj = { type: "edit", file: "src/fenced.ts", search: "before", replace: "after" };
    const raw = `Some prose here.\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\nMore prose.`;
    const result = parse(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.filePath).toBe("src/fenced.ts");
  });
});

// ---------------------------------------------------------------------------
// Validation / security tests
// ---------------------------------------------------------------------------
describe("validation", () => {
  // 11. Path traversal rejected
  test("rejects path traversal ../evil.ts", () => {
    const raw = srBlock("../evil.ts", "old", "new");
    const result = parse(raw);
    expect(result.blocks).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes("traversal"))).toBe(true);
  });

  // 12. Absolute path rejected
  test("rejects absolute path /etc/passwd", () => {
    const raw = srBlock("/etc/passwd", "root", "hacked");
    const result = parse(raw);
    expect(result.blocks).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes("Absolute"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  // 15. Garbled output → zero blocks, zero errors
  test("garbled output returns zero blocks and zero errors", () => {
    const raw = "asdfjkl; qwerty 12345 !@#$% random noise that looks like nothing";
    const result = parse(raw);
    expect(result.blocks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // 16. Empty string → zero blocks, zero errors
  test("empty string returns zero blocks and zero errors", () => {
    const result = parse("");
    expect(result.blocks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("raw string is preserved in ParseResult", () => {
    const raw = "some output";
    const result = parse(raw);
    expect(result.raw).toBe(raw);
  });
});
