import { test, expect, describe } from "bun:test";
import {
  entryName,
  exportedStub,
  buildTestFile,
  computeStats,
  formatTable,
  runModel,
  stubRunner,
  type BakeoffProblem,
  type ModelResult,
  type BakeoffStats,
} from "../scripts/run-bakeoff.ts";

// ---------------------------------------------------------------------------
// entryName
// ---------------------------------------------------------------------------
describe("entryName", () => {
  test("extracts last function name", () => {
    const prompt = "function helper(x: number): number { return x; }\nfunction target(n: number): number {\n";
    expect(entryName(prompt, "HumanEval_0_target")).toBe("target");
  });

  test("falls back to name-based stripping", () => {
    expect(entryName("const x = 1;", "HumanEval_42_sortList")).toBe("sortList");
  });
});

// ---------------------------------------------------------------------------
// exportedStub
// ---------------------------------------------------------------------------
describe("exportedStub", () => {
  test("adds export keyword", () => {
    const stub = "function add(a: number, b: number): number { return a + b; }";
    expect(exportedStub(stub, "add")).toContain("export function add");
  });

  test("idempotent", () => {
    const stub = "export function add(a: number, b: number): number { return a + b; }";
    const result = exportedStub(stub, "add");
    expect(result.match(/export\s+function/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildTestFile
// ---------------------------------------------------------------------------
describe("buildTestFile", () => {
  test("produces valid bun:test scaffold", () => {
    const tests = "import assert from 'node:assert';\nfunction test() {\n  assert(add(1,2) === 3);\n}\ntest();";
    const file = buildTestFile(tests, "add", "HumanEval_0_add");
    expect(file).toContain(`import { test as __it } from "bun:test"`);
    expect(file).toContain(`import { add } from "../src/solution.ts"`);
    expect(file).toContain("HumanEval_0_add");
    expect(file).toContain("__bo_test()");
    // trailing test() call should be stripped
    expect(file).not.toMatch(/\n\s*test\s*\(\s*\)\s*;?\s*$/);
  });
});

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------
describe("computeStats", () => {
  test("all pass → pass1=1.0", () => {
    const result: ModelResult = {
      modelId: "m1",
      passes: [[true, true, true], [true, true, true]],
      problemNames: ["p1", "p2"],
    };
    const stats = computeStats(result, 3);
    expect(stats.pass1).toBeCloseTo(1.0);
    expect(stats.passKAll).toBeCloseTo(1.0);
    expect(stats.passKAny).toBeCloseTo(1.0);
    expect(stats.totalTrials).toBe(6);
    expect(stats.totalPass).toBe(6);
  });

  test("all fail → all zeros", () => {
    const result: ModelResult = {
      modelId: "m1",
      passes: [[false, false], [false, false]],
      problemNames: ["p1", "p2"],
    };
    const stats = computeStats(result, 2);
    expect(stats.pass1).toBe(0);
    expect(stats.passKAll).toBe(0);
    expect(stats.passKAny).toBe(0);
  });

  test("mixed: 1/2 problems fully pass, 1/2 partially", () => {
    // p1: 3/3, p2: 1/3
    const result: ModelResult = {
      modelId: "m2",
      passes: [[true, true, true], [true, false, false]],
      problemNames: ["p1", "p2"],
    };
    const stats = computeStats(result, 3);
    // pass1 = 4/6
    expect(stats.pass1).toBeCloseTo(4 / 6);
    // passKAll = 1/2 (only p1 all pass)
    expect(stats.passKAll).toBeCloseTo(0.5);
    // passKAny = 2/2 (both have at least one pass)
    expect(stats.passKAny).toBeCloseTo(1.0);
    expect(stats.allKProblems).toBe(1);
    expect(stats.anyKProblems).toBe(2);
  });

  test("empty → zeros with no crash", () => {
    const result: ModelResult = { modelId: "m1", passes: [], problemNames: [] };
    const stats = computeStats(result, 3);
    expect(stats.pass1).toBe(0);
    expect(stats.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------
describe("formatTable", () => {
  const sampleStats: BakeoffStats[] = [
    {
      modelId: "vibethinker-3b",
      n: 20,
      k: 3,
      pass1: 0.828,
      passKAll: 0.748,
      passKAny: 0.906,
      totalPass: 50,
      totalTrials: 60,
      allKProblems: 15,
      anyKProblems: 18,
    },
    {
      modelId: "qwen2.5-coder-7b",
      n: 20,
      k: 3,
      pass1: 0.900,
      passKAll: 0.850,
      passKAny: 0.950,
      totalPass: 54,
      totalTrials: 60,
      allKProblems: 17,
      anyKProblems: 19,
    },
  ];

  test("contains both model IDs", () => {
    const table = formatTable(sampleStats, 3);
    expect(table).toContain("vibethinker-3b");
    expect(table).toContain("qwen2.5-coder-7b");
  });

  test("contains pass@1 values", () => {
    const table = formatTable(sampleStats, 3);
    expect(table).toContain("0.828");
    expect(table).toContain("0.900");
  });

  test("contains pass^k and pass@k headers", () => {
    const table = formatTable(sampleStats, 3);
    expect(table).toContain("pass^3");
    expect(table).toContain("pass@3");
  });

  test("returns a multi-line string with separator", () => {
    const table = formatTable(sampleStats, 3);
    const lines = table.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4); // header + sep + 2 rows
  });

  test("empty stats → only header + sep", () => {
    const table = formatTable([], 3);
    const lines = table.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2); // header + separator only
  });
});

// ---------------------------------------------------------------------------
// runModel with injected fake runner
// ---------------------------------------------------------------------------
describe("runModel (injected runner, no live model)", () => {
  // A minimal set of problems that produce deterministic test results without
  // actually running Ollama. The tests field uses the MultiPL-E assert style:
  // buildTestFile wraps it into a bun:test file. The assertion is always-true
  // (1 === 1) so the problem passes regardless of the implementation.
  const trivialProblems: BakeoffProblem[] = [
    {
      name: "HumanEval_0_trivial",
      prompt: "// returns 1\nfunction trivial(): number {\n  // TODO\n}\n",
      // MultiPL-E style: assert body. buildTestFile will wrap this.
      tests: [
        "import assert from 'node:assert';",
        "function test() {",
        "  assert(1 === 1, 'always true');",
        "}",
        "test();",
      ].join("\n"),
    },
  ];

  // A stub runner that returns a correctly-implemented solution so we can test
  // that the grading pipeline actually confirms a passing result.
  const passingRunner = async (_modelId: string, stub: string): Promise<string> => {
    // Replace the TODO stub with a real implementation
    return stub.replace("// TODO", "return 1;");
  };

  test("stub runner returns stub (will fail non-trivial tests)", async () => {
    // We use the trivial problem whose tests always pass even with a stub
    const result = await runModel("vibethinker-3b", trivialProblems, 2, stubRunner);
    expect(result.modelId).toBe("vibethinker-3b");
    expect(result.passes.length).toBe(1);
    expect(result.passes[0]!.length).toBe(2);
    // trivial test passes (assert 1===1) even with unimplemented stub
    expect(result.passes[0]).toEqual([true, true]);
  });

  test("passing runner produces all-true passes", async () => {
    const result = await runModel("vibethinker-3b", trivialProblems, 3, passingRunner);
    expect(result.passes[0]).toEqual([true, true, true]);
  });

  test("populates problemNames correctly", async () => {
    const result = await runModel("vibethinker-3b", trivialProblems, 1, stubRunner);
    expect(result.problemNames).toEqual(["HumanEval_0_trivial"]);
  });

  test("runner throwing → all false for that trial", async () => {
    const failingRunner = async (): Promise<string> => {
      throw new Error("simulated runner error");
    };
    const result = await runModel("vibethinker-3b", trivialProblems, 2, failingRunner);
    // Both trials fail due to runner error
    expect(result.passes[0]).toEqual([false, false]);
  });

  test("multi-problem aggregation via computeStats", async () => {
    // Second problem uses an intentionally-failing assert to exercise mixed results.
    const problems: BakeoffProblem[] = [
      trivialProblems[0]!,
      {
        name: "HumanEval_1_trivial2",
        prompt: "function trivial2(): number {\n  // TODO\n}\n",
        tests: [
          "import assert from 'node:assert';",
          "function test() {",
          "  assert(false, 'intentionally failing');",
          "}",
          "test();",
        ].join("\n"),
      },
    ];
    const result = await runModel("vibethinker-3b", problems, 2, stubRunner);
    const stats = computeStats(result, 2);
    expect(stats.n).toBe(2);
    expect(stats.totalTrials).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// stubRunner
// ---------------------------------------------------------------------------
describe("stubRunner", () => {
  test("returns stub unchanged regardless of modelId", async () => {
    const stub = "export function add(a: number, b: number): number { }";
    const result = await stubRunner("any-model", stub, "add");
    expect(result).toBe(stub);
  });
});
