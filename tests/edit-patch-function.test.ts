import { describe, expect, test } from "bun:test";
import {
  applyPatchBlock,
  chooseEditFormat,
  PATCH_BYTE_THRESHOLD,
  PATCH_LINE_THRESHOLD,
  parsePatchBlocks,
} from "../src/edit/patch-function.ts";
import { parse } from "../src/edit/parser.ts";
import { applyBlock } from "../src/edit/applier.ts";
import type { PatchBlock } from "../src/edit/patch-function.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A simple TypeScript file with two top-level functions. */
const SIMPLE_FILE = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;

/** A file with three functions and some surrounding context. */
const THREE_FN_FILE = `// header comment
export function alpha(): string {
  return "alpha";
}

export function beta(x: number): number {
  if (x > 0) {
    return x * 2;
  }
  return 0;
}

export function gamma(): void {
  console.log("gamma");
}
`;

/** Replacement for the `beta` function. */
const BETA_REPLACEMENT = `export function beta(x: number): number {
  return x * 3;
}
`;

// ---------------------------------------------------------------------------
// parsePatchBlocks
// ---------------------------------------------------------------------------

describe("parsePatchBlocks — parse", () => {
  test("parses a well-formed PATCH block", () => {
    const raw = `PATCH: src/foo.ts
FUNCTION: add
\`\`\`ts
export function add(a: number, b: number): number {
  return a + b + 1;
}
\`\`\`
`;
    const result = parsePatchBlocks(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0]!;
    expect(block.filePath).toBe("src/foo.ts");
    expect(block.functionName).toBe("add");
    expect(block.format).toBe("patch-function");
    expect(block.replacement).toContain("return a + b + 1;");
  });

  test("strips leading ./ from path", () => {
    const raw = `PATCH: ./src/foo.ts
FUNCTION: add
\`\`\`
export function add() {}
\`\`\`
`;
    const result = parsePatchBlocks(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks[0]!.filePath).toBe("src/foo.ts");
  });

  test("rejects absolute path", () => {
    const raw = `PATCH: /etc/passwd
FUNCTION: evil
\`\`\`
root
\`\`\`
`;
    const result = parsePatchBlocks(raw);
    expect(result.blocks).toHaveLength(0);
    expect(result.errors.some((e) => e.message.includes("Absolute"))).toBe(true);
  });

  test("rejects path traversal", () => {
    const raw = `PATCH: ../evil.ts
FUNCTION: bad
\`\`\`
code
\`\`\`
`;
    const result = parsePatchBlocks(raw);
    expect(result.blocks).toHaveLength(0);
    expect(result.errors.some((e) => e.message.includes("traversal"))).toBe(true);
  });

  test("error if FUNCTION: line is missing", () => {
    const raw = `PATCH: src/foo.ts
\`\`\`
export function add() {}
\`\`\`
`;
    const result = parsePatchBlocks(raw);
    expect(result.blocks).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("error if opening fence is missing", () => {
    const raw = `PATCH: src/foo.ts
FUNCTION: add
export function add() {}
`;
    const result = parsePatchBlocks(raw);
    expect(result.blocks).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("error if closing fence is missing", () => {
    const raw = `PATCH: src/foo.ts
FUNCTION: add
\`\`\`
export function add() {
  return 1;
`;
    const result = parsePatchBlocks(raw);
    expect(result.blocks).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("preserves trailing newline on replacement", () => {
    const raw = `PATCH: src/foo.ts
FUNCTION: add
\`\`\`
export function add() {
  return 1;
}
\`\`\`
`;
    const result = parsePatchBlocks(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.blocks[0]!.replacement.endsWith("\n")).toBe(true);
  });

  test("PATCH block parsed by top-level parse()", () => {
    const raw = `PATCH: src/foo.ts
FUNCTION: add
\`\`\`ts
export function add(a: number, b: number): number {
  return a + b + 1;
}
\`\`\`
`;
    const result = parse(raw);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.format).toBe("patch-function");
    expect(result.blocks[0]!.filePath).toBe("src/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// applyPatchBlock — happy path
// ---------------------------------------------------------------------------

describe("applyPatchBlock — happy path", () => {
  test("replaces target function, leaving other functions byte-identical", () => {
    const patch: PatchBlock = {
      filePath: "src/math.ts",
      functionName: "subtract",
      replacement: `export function subtract(a: number, b: number): number {\n  return a - b - 1;\n}\n`,
      format: "patch-function",
    };
    const result = applyPatchBlock(patch, SIMPLE_FILE);

    expect(result.status).toBe("applied");
    expect(result.newContent).toBeDefined();

    const newContent = result.newContent!;
    // Target function changed
    expect(newContent).toContain("return a - b - 1;");
    // Unchanged function is byte-identical
    const addStart = SIMPLE_FILE.indexOf("export function add");
    const addEnd = SIMPLE_FILE.indexOf("\n\n", addStart) + 2;
    const originalAddFn = SIMPLE_FILE.slice(addStart, addEnd);
    expect(newContent).toContain(originalAddFn);
  });

  test("replaces middle function in a three-function file", () => {
    const patch: PatchBlock = {
      filePath: "src/utils.ts",
      functionName: "beta",
      replacement: BETA_REPLACEMENT,
      format: "patch-function",
    };
    const result = applyPatchBlock(patch, THREE_FN_FILE);

    expect(result.status).toBe("applied");
    const newContent = result.newContent!;

    // Changed function
    expect(newContent).toContain("return x * 3;");
    // alpha function unchanged
    expect(newContent).toContain('return "alpha";');
    // gamma function unchanged
    expect(newContent).toContain('console.log("gamma");');
    // old beta body removed
    expect(newContent).not.toContain("return x * 2;");
  });

  test("originalContent is the input content", () => {
    const patch: PatchBlock = {
      filePath: "src/utils.ts",
      functionName: "beta",
      replacement: BETA_REPLACEMENT,
      format: "patch-function",
    };
    const result = applyPatchBlock(patch, THREE_FN_FILE);
    expect(result.originalContent).toBe(THREE_FN_FILE);
  });

  test("diff is non-empty on successful apply", () => {
    const patch: PatchBlock = {
      filePath: "src/utils.ts",
      functionName: "beta",
      replacement: BETA_REPLACEMENT,
      format: "patch-function",
    };
    const result = applyPatchBlock(patch, THREE_FN_FILE);
    expect(result.diff).toBeTruthy();
  });

  test("via applyBlock dispatch with patch-function format", () => {
    // Confirm that applyBlock correctly dispatches to the patch applier
    // when the EditBlock has format="patch-function" and the sentinel search prefix.
    const raw = `PATCH: src/math.ts
FUNCTION: add
\`\`\`
export function add(a: number, b: number): number {
  return a + b + 100;
}
\`\`\`
`;
    const parseResult = parse(raw);
    expect(parseResult.blocks).toHaveLength(1);
    const editBlock = parseResult.blocks[0]!;
    expect(editBlock.format).toBe("patch-function");

    const result = applyBlock(editBlock, SIMPLE_FILE);
    expect(result.status).toBe("applied");
    expect(result.newContent).toContain("return a + b + 100;");
    // subtract function unchanged
    expect(result.newContent).toContain("return a - b;");
  });
});

// ---------------------------------------------------------------------------
// applyPatchBlock — fail-safe: not found
// ---------------------------------------------------------------------------

describe("applyPatchBlock — not_found", () => {
  test("returns not_found when anchor line does not exist in file", () => {
    const patch: PatchBlock = {
      filePath: "src/foo.ts",
      functionName: "nonExistent",
      replacement: `export function nonExistent(): void {\n  // new body\n}\n`,
      format: "patch-function",
    };
    const result = applyPatchBlock(patch, SIMPLE_FILE);

    expect(result.status).toBe("not_found");
    expect(result.error).toBeDefined();
    // CRITICAL: no write — newContent must be undefined
    expect(result.newContent).toBeUndefined();
  });

  test("returns not_found for completely empty file", () => {
    const patch: PatchBlock = {
      filePath: "src/empty.ts",
      functionName: "anything",
      replacement: `export function anything() {}\n`,
      format: "patch-function",
    };
    const result = applyPatchBlock(patch, "");
    expect(result.status).toBe("not_found");
    expect(result.newContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyPatchBlock — fail-safe: ambiguous
// ---------------------------------------------------------------------------

describe("applyPatchBlock — ambiguous", () => {
  test("returns ambiguous when anchor line appears more than once", () => {
    // Duplicate the add function signature to create an ambiguous anchor
    const ambiguous = `export function add(a: number, b: number): number {
  return a + b;
}

export function add(a: number, b: number): number {
  return a + b + 1;
}
`;
    const patch: PatchBlock = {
      filePath: "src/dup.ts",
      functionName: "add",
      replacement: `export function add(a: number, b: number): number {\n  return 0;\n}\n`,
      format: "patch-function",
    };
    const result = applyPatchBlock(patch, ambiguous);

    expect(result.status).toBe("ambiguous");
    expect(result.error).toBeDefined();
    // CRITICAL: no write
    expect(result.newContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// chooseEditFormat — thresholds
// ---------------------------------------------------------------------------

describe("chooseEditFormat", () => {
  test("returns 'full' for a small file (0 lines)", () => {
    expect(chooseEditFormat(0)).toBe("full");
  });

  test("returns 'full' at exactly the line threshold", () => {
    expect(chooseEditFormat(PATCH_LINE_THRESHOLD)).toBe("full");
  });

  test("returns 'patch' one line above the line threshold", () => {
    expect(chooseEditFormat(PATCH_LINE_THRESHOLD + 1)).toBe("patch");
  });

  test("returns 'patch' one byte above the byte threshold (when below line threshold)", () => {
    // Pass byte count directly; use a value above PATCH_BYTE_THRESHOLD but below PATCH_LINE_THRESHOLD
    // Since PATCH_LINE_THRESHOLD (300) < PATCH_BYTE_THRESHOLD (8192), any value in (300, 8192]
    // already exceeds the line threshold. We test with a value above PATCH_BYTE_THRESHOLD.
    expect(chooseEditFormat(PATCH_BYTE_THRESHOLD + 1)).toBe("patch");
  });

  test("returns 'patch' at exactly the byte threshold because it exceeds the line threshold", () => {
    // PATCH_BYTE_THRESHOLD (8192) > PATCH_LINE_THRESHOLD (300), so 'patch' is returned
    // (the sizeMetric exceeds at least one of the two thresholds)
    expect(chooseEditFormat(PATCH_BYTE_THRESHOLD)).toBe("patch");
  });

  test("returns 'full' for a value at the line threshold but below both thresholds", () => {
    // Exactly at line threshold: not strictly greater → "full"
    expect(chooseEditFormat(PATCH_LINE_THRESHOLD)).toBe("full");
  });

  test("returns 'patch' for a very large number", () => {
    expect(chooseEditFormat(999_999)).toBe("patch");
  });
});

// ---------------------------------------------------------------------------
// Existing full-file blocks are NOT disturbed by PATCH parser
// ---------------------------------------------------------------------------

describe("full-file blocks unaffected", () => {
  test("FILE: block still parsed when no PATCH: present", () => {
    const raw = `FILE: src/math.ts
\`\`\`ts
export function add(a: number, b: number): number {
  return a + b;
}
\`\`\`
`;
    const result = parse(raw);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.format).toBe("full-file");
  });

  test("PATCH: takes priority when both exist in the same response", () => {
    // The parser picks PATCH first; FILE: blocks are ignored if PATCH blocks are found.
    const raw = `PATCH: src/math.ts
FUNCTION: add
\`\`\`
export function add(a: number, b: number): number {
  return a + b + 1;
}
\`\`\`

FILE: src/other.ts
\`\`\`
const x = 1;
\`\`\`
`;
    const result = parse(raw);
    // PATCH takes priority (first successful parser wins)
    expect(result.blocks[0]!.format).toBe("patch-function");
  });
});
