import { describe, expect, it } from "bun:test";
import { applyBatch, applyBlock, generateDiff, OFF_TARGET_EDIT_REJECTED } from "../src/edit/applier.ts";
import { repairBlock } from "../src/edit/repair.ts";
import type { EditBlock } from "../src/edit/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function block(filePath: string, search: string, replace: string): EditBlock {
  return { filePath, search, replace, format: "search-replace" };
}

// ---------------------------------------------------------------------------
// applyBlock
// ---------------------------------------------------------------------------

describe("applyBlock", () => {
  it("1. exact match → status applied, newContent correct", () => {
    const content = "hello world\nfoo bar\nbaz";
    const result = applyBlock(block("a.ts", "foo bar", "qux quux"), content);

    expect(result.status).toBe("applied");
    expect(result.newContent).toBe("hello world\nqux quux\nbaz");
    expect(result.originalContent).toBe(content);
  });

  it("2. empty search → full replace, status applied", () => {
    const result = applyBlock(block("a.ts", "", "brand new content"), "old stuff");

    expect(result.status).toBe("applied");
    expect(result.newContent).toBe("brand new content");
    expect(result.originalContent).toBe("old stuff");
  });

  it("3. search not found → status not_found", () => {
    const result = applyBlock(block("a.ts", "NOTHERE", "x"), "hello world");

    expect(result.status).toBe("not_found");
    expect(result.newContent).toBeUndefined();
  });

  it("4. search appears twice → status ambiguous", () => {
    const content = "abc abc";
    const result = applyBlock(block("a.ts", "abc", "xyz"), content);

    expect(result.status).toBe("ambiguous");
  });

  it("14. preserves surrounding content unchanged", () => {
    const before = "BEFORE\n";
    const after = "\nAFTER";
    const search = "middle text";
    const replace = "replaced";
    const content = before + search + after;
    const result = applyBlock(block("a.ts", search, replace), content);

    expect(result.status).toBe("applied");
    expect(result.newContent).toBe(before + replace + after);
  });
});

// ---------------------------------------------------------------------------
// generateDiff
// ---------------------------------------------------------------------------

describe("generateDiff", () => {
  it("5. produces correct unified diff format", () => {
    const original = "line1\nline2\nline3\n";
    const modified = "line1\nchanged\nline3\n";
    const diff = generateDiff(original, modified, "src/foo.ts");

    expect(diff).toContain("--- a/src/foo.ts");
    expect(diff).toContain("+++ b/src/foo.ts");
    expect(diff).toMatch(/^@@ .* @@/m);
    expect(diff).toContain("-line2");
    expect(diff).toContain("+changed");
  });

  it("6. identical content → empty diff string", () => {
    const content = "no changes here\n";
    expect(generateDiff(content, content, "x.ts")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// applyBatch
// ---------------------------------------------------------------------------

describe("applyBatch", () => {
  it("7. second block sees first block's in-memory changes", async () => {
    const fs = new Map<string, string>([["f.ts", "alpha beta gamma"]]);

    const readFile = async (p: string) => fs.get(p) ?? null;
    const writeFile = async (p: string, c: string) => {
      fs.set(p, c);
    };

    const blocks: EditBlock[] = [
      block("f.ts", "alpha", "ALPHA"),
      block("f.ts", "ALPHA beta", "ALPHA BETA"),
    ];

    const result = await applyBatch(blocks, readFile, writeFile);

    expect(result.allApplied).toBe(true);
    expect(fs.get("f.ts")).toBe("ALPHA BETA gamma");
  });

  it("8. allApplied=false if any block fails", async () => {
    const readFile = async (_p: string) => "hello world";
    const writes: string[] = [];
    const writeFile = async (_p: string, _c: string) => {
      writes.push(_p);
    };

    const blocks: EditBlock[] = [block("a.ts", "hello", "hi"), block("a.ts", "NOTHERE", "x")];

    const result = await applyBatch(blocks, readFile, writeFile);

    expect(result.allApplied).toBe(false);
    expect(result.results[0]?.status).toBe("applied");
    expect(result.results[1]?.status).toBe("not_found");
  });

  it("13. new file: readFile returns null → write with empty original", async () => {
    const written = new Map<string, string>();
    const readFile = async (_p: string): Promise<string | null> => null;
    const writeFile = async (p: string, c: string) => {
      written.set(p, c);
    };

    const blocks: EditBlock[] = [block("new.ts", "", "fresh content")];
    const result = await applyBatch(blocks, readFile, writeFile);

    expect(result.allApplied).toBe(true);
    expect(written.get("new.ts")).toBe("fresh content");
  });

  // Multi-file target set (SMALLCODE_TARGET_SET): targetPaths supersedes the
  // single targetPath — any member is on-target, anything else is rejected.
  it("14. targetPaths allows edits to any member of the set", async () => {
    const fs = new Map<string, string>([
      ["src/index.js", "aaa"],
      ["src/money.js", "bbb"],
    ]);
    const readFile = async (p: string) => fs.get(p) ?? null;
    const writeFile = async (p: string, c: string) => {
      fs.set(p, c);
    };
    const blocks: EditBlock[] = [block("src/index.js", "aaa", "AAA"), block("src/money.js", "bbb", "BBB")];
    const result = await applyBatch(blocks, readFile, writeFile, {
      targetPaths: ["src/index.js", "src/money.js"],
    });
    expect(result.allApplied).toBe(true);
    expect(fs.get("src/index.js")).toBe("AAA");
    expect(fs.get("src/money.js")).toBe("BBB");
  });

  it("15. targetPaths rejects an edit outside the set", async () => {
    const fs = new Map<string, string>([["src/other.js", "ccc"]]);
    const readFile = async (p: string) => fs.get(p) ?? null;
    const writeFile = async (p: string, c: string) => {
      fs.set(p, c);
    };
    const blocks: EditBlock[] = [block("src/other.js", "ccc", "CCC")];
    const result = await applyBatch(blocks, readFile, writeFile, {
      targetPaths: ["src/index.js", "src/money.js"],
    });
    expect(result.results[0]?.status).toBe("error");
    expect(result.results[0]?.error).toContain(OFF_TARGET_EDIT_REJECTED);
    expect(fs.get("src/other.js")).toBe("ccc"); // unchanged
  });
});

// ---------------------------------------------------------------------------
// repairBlock
// ---------------------------------------------------------------------------

describe("repairBlock", () => {
  it("9. exact match → strategy exact, confidence 1.0", () => {
    const content = "function foo() { return 1; }";
    const b = block("a.ts", "function foo()", "function bar()");
    const r = repairBlock(b, content);

    expect(r.strategy).toBe("exact");
    expect(r.confidence).toBe(1.0);
    expect(r.repairedBlock).not.toBeNull();
    expect(r.repairedBlock?.search).toBe("function foo()");
  });

  it("10. extra whitespace → strategy whitespace, repaired block applies cleanly", () => {
    // Content has double space; search has single space
    const content = "function  foo() {\n  return  1;\n}";
    const search = "function foo() {\n  return 1;\n}";
    const b = block("a.ts", search, "replaced");
    const r = repairBlock(b, content);

    expect(r.strategy).toBe("whitespace");
    expect(r.repairedBlock).not.toBeNull();
    // repaired block should apply cleanly against original content
    const applyResult = applyBlock(r.repairedBlock!, content);
    expect(applyResult.status).toBe("applied");
  });

  it("11. unfindable content → strategy failed, repairedBlock null", () => {
    const content = "totally unrelated content here";
    // search is very different — won't fuzzy-match at >= 0.85
    const b = block("a.ts", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "y");
    const r = repairBlock(b, content);

    expect(r.strategy).toBe("failed");
    expect(r.repairedBlock).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("12. fuzzy match ≥0.85 → strategy fuzzy, repairedBlock non-null", () => {
    // A string very close to something in content (a few chars different)
    const content = "export function calculateTotal(items: Item[]): number {";
    // Slightly mutated version — change a couple of chars
    const search = "export function calculateTotall(items: Item[]): number {";
    const b = block("a.ts", search, "replaced");
    const r = repairBlock(b, content);

    // Should either be whitespace or fuzzy with confidence >= 0.85
    expect(["whitespace", "fuzzy"]).toContain(r.strategy);
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r.repairedBlock).not.toBeNull();
  });
});
