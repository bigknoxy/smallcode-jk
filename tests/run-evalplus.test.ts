import { test, expect, describe } from "bun:test";
import {
  entryName,
  exportedStub,
  splitTests,
  buildTestFile,
  aggregateResults,
  stubSolutionSource,
  type EvalPlusResult,
} from "../scripts/run-evalplus.ts";

// ---------------------------------------------------------------------------
// entryName
// ---------------------------------------------------------------------------
describe("entryName", () => {
  test("extracts last function name from stub", () => {
    const prompt = "// some helper\nfunction helper(x: number): number { return x; }\n// target\nfunction addTwo(n: number): number {\n";
    expect(entryName(prompt, "HumanEval_0_addTwo")).toBe("addTwo");
  });

  test("falls back to name-based extraction when no function keyword", () => {
    expect(entryName("const x = 1;", "HumanEval_42_sortList")).toBe("sortList");
  });

  test("handles nested arrow functions — picks the last named function", () => {
    const prompt = "function outer(x: number) {\n  const inner = () => x;\n  return inner();\n}\nfunction target(a: number) {\n";
    expect(entryName(prompt, "HumanEval_1_target")).toBe("target");
  });
});

// ---------------------------------------------------------------------------
// exportedStub
// ---------------------------------------------------------------------------
describe("exportedStub", () => {
  test("adds export to target function", () => {
    const stub = "function add(a: number, b: number): number {\n  return a + b;\n}";
    const result = exportedStub(stub, "add");
    expect(result).toContain("export function add");
  });

  test("does not double-export", () => {
    const stub = "export function add(a: number, b: number): number {\n  return a + b;\n}";
    const result = exportedStub(stub, "add");
    expect(result.match(/export\s+function\s+add/g)?.length ?? 0).toBe(1);
  });

  test("only exports the target function, not helpers", () => {
    const stub = "function helper(x: number): number { return x; }\nfunction main(n: number): number {\n";
    const result = exportedStub(stub, "main");
    expect(result).toContain("export function main");
    expect(result).not.toContain("export function helper");
  });
});

// ---------------------------------------------------------------------------
// splitTests
// ---------------------------------------------------------------------------
describe("splitTests", () => {
  const rawTests = [
    "import assert from 'node:assert';",
    "function test() {",
    "  assert(add(1, 2) === 3);",
    "  assert(add(0, 0) === 0);",
    "  assert(add(-1, 1) === 0);",
    "  assert(add(5, 5) === 10);",
    "}",
    "test();",
  ].join("\n");

  test("splits assert lines at 50% by default", () => {
    const { base, extra } = splitTests(rawTests, 0.5);
    const baseAsserts = base.filter((l) => /assert\s*\(/.test(l));
    const extraAsserts = extra.filter((l) => /assert\s*\(/.test(l));
    // 4 asserts total, split at 50% → ceil(2) = 2 each
    expect(baseAsserts.length).toBe(2);
    expect(extraAsserts.length).toBe(2);
  });

  test("split at 1.0 puts all asserts in base, none in extra", () => {
    const { base, extra } = splitTests(rawTests, 1.0);
    const baseAsserts = base.filter((l) => /assert\s*\(/.test(l));
    const extraAsserts = extra.filter((l) => /assert\s*\(/.test(l));
    expect(baseAsserts.length).toBe(4);
    expect(extraAsserts.length).toBe(0);
  });

  test("split at 0 still keeps at least 1 assert in base", () => {
    const { base } = splitTests(rawTests, 0);
    const baseAsserts = base.filter((l) => /assert\s*\(/.test(l));
    expect(baseAsserts.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// buildTestFile
// ---------------------------------------------------------------------------
describe("buildTestFile", () => {
  const assertLines = [
    "import assert from 'node:assert';",
    "assert(add(1, 2) === 3);",
    "assert(add(0, 0) === 0);",
  ];

  test("generates valid bun:test file for base segment", () => {
    const result = buildTestFile(assertLines, "add", "HumanEval_0_add", "base");
    expect(result).not.toBeNull();
    expect(result).toContain(`import { test as __it } from "bun:test"`);
    expect(result).toContain(`import { add } from "../src/solution.ts"`);
    expect(result).toContain("HumanEval_0_add:base");
    expect(result).toContain("__ep_test()");
  });

  test("returns null for segment with no assert lines", () => {
    const emptyLines = ["// nothing here", "const x = 1;"];
    const result = buildTestFile(emptyLines, "add", "HumanEval_0_add", "extra");
    expect(result).toBeNull();
  });

  test("returns null for empty segment", () => {
    const result = buildTestFile([], "add", "HumanEval_0_add", "extra");
    expect(result).toBeNull();
  });

  test("labels extra segment correctly", () => {
    const result = buildTestFile(assertLines, "fn", "prob", "extra");
    expect(result).toContain("prob:extra");
  });
});

// ---------------------------------------------------------------------------
// aggregateResults
// ---------------------------------------------------------------------------
describe("aggregateResults", () => {
  test("all pass → pass1 = 1.0", () => {
    const results: EvalPlusResult[] = [
      { name: "p1", passes: [{ base: true, extra: true }, { base: true, extra: true }] },
      { name: "p2", passes: [{ base: true, extra: true }, { base: true, extra: true }] },
    ];
    const agg = aggregateResults(results, 2);
    expect(agg.pass1Base).toBeCloseTo(1.0);
    expect(agg.pass1Extra).toBeCloseTo(1.0);
    expect(agg.passKBase).toBeCloseTo(1.0);
    expect(agg.passKExtra).toBeCloseTo(1.0);
  });

  test("all fail → pass1 = 0.0", () => {
    const results: EvalPlusResult[] = [
      { name: "p1", passes: [{ base: false, extra: false }, { base: false, extra: false }] },
    ];
    const agg = aggregateResults(results, 2);
    expect(agg.pass1Base).toBeCloseTo(0.0);
    expect(agg.pass1Extra).toBeCloseTo(0.0);
  });

  test("base pass but extra fail → extra pass1 = 0", () => {
    // extra is only counted when base AND extra both pass
    const results: EvalPlusResult[] = [
      { name: "p1", passes: [{ base: true, extra: false }] },
    ];
    const agg = aggregateResults(results, 1);
    expect(agg.pass1Base).toBeCloseTo(1.0);
    expect(agg.pass1Extra).toBeCloseTo(0.0);
  });

  test("mixed results compute correctly", () => {
    // 2 problems, k=3 each
    // p1: 2/3 base, 1/3 extra
    // p2: 3/3 base, 3/3 extra
    const results: EvalPlusResult[] = [
      {
        name: "p1",
        passes: [
          { base: true, extra: true },
          { base: true, extra: false },
          { base: false, extra: false },
        ],
      },
      {
        name: "p2",
        passes: [
          { base: true, extra: true },
          { base: true, extra: true },
          { base: true, extra: true },
        ],
      },
    ];
    const agg = aggregateResults(results, 3);
    // totalTrials = 6, basePass = 5, extraPass (base&&extra) = 4
    expect(agg.pass1Base).toBeCloseTo(5 / 6);
    expect(agg.pass1Extra).toBeCloseTo(4 / 6);
    // allK base: p2 only → 1/2
    expect(agg.passKBase).toBeCloseTo(1 / 2);
    // allK extra: p2 only → 1/2
    expect(agg.passKExtra).toBeCloseTo(1 / 2);
    // anyK base: both → 2/2
    expect(agg.anyKPassBase).toBe(2);
    // anyK extra: both → 2/2
    expect(agg.anyKPassExtra).toBe(2);
  });

  test("empty results → all zeros", () => {
    const agg = aggregateResults([], 3);
    expect(agg.pass1Base).toBe(0);
    expect(agg.pass1Extra).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// stubSolutionSource (dry-run injection)
// ---------------------------------------------------------------------------
describe("stubSolutionSource", () => {
  test("returns stub unchanged", async () => {
    const stub = "export function add(a: number, b: number): number { /* TODO */ }";
    const result = await stubSolutionSource(stub, "add");
    expect(result).toBe(stub);
  });
});
