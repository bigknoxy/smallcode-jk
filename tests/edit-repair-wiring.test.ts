import { describe, expect, it } from "bun:test";
import { applyBlock, truncationReason } from "../src/edit/applier.ts";
import type { EditBlock } from "../src/edit/types.ts";

function sr(filePath: string, search: string, replace: string): EditBlock {
  return { filePath, search, replace, format: "search-replace" };
}
function full(filePath: string, replace: string): EditBlock {
  return { filePath, search: "", replace, format: "full-file" };
}

// ---------------------------------------------------------------------------
// repairBlock wiring — non-exact search now applies via fuzzy repair
// ---------------------------------------------------------------------------

describe("applyBlock — repair wiring for search/replace", () => {
  it("exact match applies with no repair annotation", () => {
    const content = "const x = 1;\nconst y = 2;\n";
    const r = applyBlock(sr("a.ts", "const x = 1;", "const x = 42;"), content);
    expect(r.status).toBe("applied");
    expect(r.repair).toBeUndefined();
    expect(r.newContent).toContain("const x = 42;");
  });

  it("whitespace-drifted search applies via repair and records the strategy", () => {
    const content = "const x = 1;\nconst y = 2;\n";
    // Model emitted collapsed/extra spaces — exact indexOf fails.
    const r = applyBlock(sr("a.ts", "const  x  =  1;", "const x = 42;"), content);
    expect(r.status).toBe("applied");
    expect(r.repair?.strategy).toBe("whitespace");
    expect(r.newContent).toBe("const x = 42;\nconst y = 2;\n");
  });

  it("multiline whitespace-drifted search applies via repair", () => {
    const content = "if (x) {\n  doThing();\n}\n";
    // Model emitted a double space before the brace — exact match fails.
    const r = applyBlock(
      sr("a.ts", "if (x)  {\n  doThing();\n}", "if (y) {\n  doThing();\n}"),
      content,
    );
    expect(r.status).toBe("applied");
    expect(r.repair).toBeDefined();
    expect(r.newContent).toBe("if (y) {\n  doThing();\n}\n");
  });

  it("genuinely absent search stays not_found (repair cannot salvage)", () => {
    const content = "const x = 1;\n";
    const r = applyBlock(sr("a.ts", "completelyDifferentSymbol(qwerty)", "x"), content);
    expect(r.status).toBe("not_found");
    expect(r.newContent).toBeUndefined();
  });

  it("does not corrupt content when repair retry would be ambiguous", () => {
    // Two identical lines; a drifted search could fuzzy-match either → keep safe.
    const content = "foo();\nfoo();\n";
    const r = applyBlock(sr("a.ts", "foo();", "bar();"), content);
    // Exact search matches twice → ambiguous, untouched.
    expect(r.status).toBe("ambiguous");
    expect(r.newContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// truncationReason — whole-file integrity guard
// ---------------------------------------------------------------------------

describe("truncationReason", () => {
  it("allows a brand-new (empty original) file", () => {
    expect(truncationReason("", "anything at all\nmore\n")).toBeNull();
  });

  it("allows a balanced same-size rewrite", () => {
    const orig = "function f() {\n  return 1;\n}\n";
    const next = "function f() {\n  return 2;\n}\n";
    expect(truncationReason(orig, next)).toBeNull();
  });

  it("flags unbalanced brackets when original was balanced (cut off mid-file)", () => {
    const orig = "function f() {\n  return 1;\n}\n";
    const truncated = "function f() {\n  return 1;"; // missing closing brace
    expect(truncationReason(orig, truncated)).toContain("unbalanced");
  });

  it("flags blanking a non-empty file", () => {
    expect(truncationReason("const x = 1;\n", "   ")).toContain("empty");
  });

  it("flags >50% line loss on a non-trivial file", () => {
    const orig = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const truncated = Array.from({ length: 6 }, (_, i) => `const v${i} = ${i};`).join("\n");
    expect(truncationReason(orig, truncated)).toContain("shrink");
  });

  it("allows a legitimate balanced refactor that shrinks a small file modestly", () => {
    const orig = "function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
    const next = "function f() {\n  return 3;\n}\n";
    expect(truncationReason(orig, next)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyBlock — full-file guard integration
// ---------------------------------------------------------------------------

describe("applyBlock — full-file truncation guard", () => {
  it("rejects a truncated whole-file write and does NOT overwrite", () => {
    const content = "function f() {\n  return 1;\n}\n";
    const r = applyBlock(full("a.ts", "function f() {\n  return 1;"), content);
    expect(r.status).toBe("error");
    expect(r.error).toContain("rejected");
    expect(r.newContent).toBeUndefined(); // nothing written
  });

  it("applies a valid whole-file rewrite", () => {
    const content = "function f() {\n  return 1;\n}\n";
    const next = "function f() {\n  return 2;\n}\n";
    const r = applyBlock(full("a.ts", next), content);
    expect(r.status).toBe("applied");
    expect(r.newContent).toBe(next);
  });

  it("applies a new file (empty original) verbatim", () => {
    const next = "export const x = 1;\n";
    const r = applyBlock(full("new.ts", next), "");
    expect(r.status).toBe("applied");
    expect(r.newContent).toBe(next);
  });
});
