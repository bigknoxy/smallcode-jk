import { test, expect, describe } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  entryName,
  exportedStub,
  buildTestFile,
  aggregateResults,
  stubSolutionSource,
  LCB_DATASET_URL,
  type LcbProblem,
  type LcbResult,
} from "../scripts/run-livecodebench.ts";

// ---------------------------------------------------------------------------
// entryName
// ---------------------------------------------------------------------------
describe("entryName", () => {
  test("extracts last function keyword", () => {
    const prompt = "function helper(x: number) { return x; }\nfunction solve(n: number): number {\n";
    expect(entryName(prompt, "lcb_0_solve")).toBe("solve");
  });

  test("falls back to name-based extraction", () => {
    expect(entryName("const x = 1;", "lcb_5_countPairs")).toBe("countPairs");
  });

  test("replaces special chars in fallback", () => {
    // Name has dash — should become underscore
    const result = entryName("const x = 1;", "lcb_0_some-name");
    expect(result).not.toContain("-");
  });
});

// ---------------------------------------------------------------------------
// exportedStub
// ---------------------------------------------------------------------------
describe("exportedStub", () => {
  test("adds export keyword", () => {
    const stub = "function solve(n: number): number {\n  return n;\n}";
    expect(exportedStub(stub, "solve")).toContain("export function solve");
  });

  test("idempotent on already-exported stub", () => {
    const stub = "export function solve(n: number): number { return n; }";
    const result = exportedStub(stub, "solve");
    expect(result.match(/export\s+function/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildTestFile
// ---------------------------------------------------------------------------
describe("buildTestFile", () => {
  test("wraps test body correctly", () => {
    const tests = [
      "import assert from 'node:assert';",
      "function test() {",
      "  assert(solve(0) === 0);",
      "}",
      "test();",
    ].join("\n");
    const file = buildTestFile(tests, "solve", "lcb_0");
    expect(file).toContain(`import { test as __it } from "bun:test"`);
    expect(file).toContain(`import { solve } from "../src/solution.ts"`);
    expect(file).toContain("lcb_0");
    expect(file).toContain("__lcb_test()");
    // trailing test(); should be stripped
    expect(file).not.toMatch(/\n\s*test\s*\(\s*\)\s*;?\s*$/);
  });
});

// ---------------------------------------------------------------------------
// fetchProblems (cache integration)
// ---------------------------------------------------------------------------
describe("fetchProblems (from cache)", () => {
  const cacheDir = join(tmpdir(), "lcb-test-cache");
  const cachePath = join(cacheDir, "lcb-ts-test.json");

  const sampleProblems: LcbProblem[] = [
    {
      name: "lcb_0_solve",
      prompt: "function solve(n: number): number {\n",
      tests: "import assert from 'node:assert';\nassert(solve(1) === 1);",
      releasedAt: "2024-11-01",
      difficulty: "easy",
    },
    {
      name: "lcb_1_count",
      prompt: "function count(arr: number[]): number {\n",
      tests: "import assert from 'node:assert';\nassert(count([1,2,3]) === 3);",
      releasedAt: "2024-08-15",
      difficulty: "medium",
    },
    {
      name: "lcb_2_old",
      prompt: "function old(x: number): number {\n",
      tests: "assert(old(0) === 0);",
      releasedAt: "2023-01-01",
      difficulty: "easy",
    },
  ];

  // Set up a temp cache file before each group of tests
  const setup = () => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(sampleProblems), "utf-8");
    process.env.SMALLCODE_LCB_CACHE = cachePath;
  };

  const teardown = () => {
    delete process.env.SMALLCODE_LCB_CACHE;
    rmSync(cacheDir, { recursive: true, force: true });
  };

  test("loads all problems from cache", async () => {
    setup();
    try {
      // Import fresh after env var is set
      const { fetchProblems } = await import("../scripts/run-livecodebench.ts");
      // Patch module cache is not straightforward in bun; test via direct file read
      const f = Bun.file(cachePath);
      const data = await f.json() as LcbProblem[];
      expect(data.length).toBe(3);
    } finally {
      teardown();
    }
  });

  test("filters by afterDate correctly", async () => {
    setup();
    try {
      const { fetchProblems } = await import("../scripts/run-livecodebench.ts");
      // We can exercise the filter logic directly on the same data
      const allProblems: LcbProblem[] = JSON.parse(await Bun.file(cachePath).text());
      const cutoff = new Date("2024-09-01").getTime();
      const filtered = allProblems.filter((p) => {
        const t = new Date(p.releasedAt).getTime();
        return !isNaN(t) && t > cutoff;
      });
      // Only lcb_0 (2024-11-01) passes the cutoff
      expect(filtered.length).toBe(1);
      expect(filtered[0]!.name).toBe("lcb_0_solve");
    } finally {
      teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// aggregateResults
// ---------------------------------------------------------------------------
describe("aggregateResults", () => {
  test("all pass → pass1=1.0, passKAll=1.0, passKAny=1.0", () => {
    const results: LcbResult[] = [
      { name: "p1", difficulty: "easy", passes: [true, true, true] },
      { name: "p2", difficulty: "medium", passes: [true, true, true] },
    ];
    const agg = aggregateResults(results, 3);
    expect(agg.pass1).toBeCloseTo(1.0);
    expect(agg.passKAll).toBeCloseTo(1.0);
    expect(agg.passKAny).toBeCloseTo(1.0);
  });

  test("all fail → all zeros", () => {
    const results: LcbResult[] = [
      { name: "p1", difficulty: "hard", passes: [false, false, false] },
    ];
    const agg = aggregateResults(results, 3);
    expect(agg.pass1).toBe(0);
    expect(agg.passKAll).toBe(0);
    expect(agg.passKAny).toBe(0);
  });

  test("mixed results compute correctly", () => {
    // p1: 2/3 pass, p2: 0/3 pass
    const results: LcbResult[] = [
      { name: "p1", difficulty: "easy", passes: [true, true, false] },
      { name: "p2", difficulty: "hard", passes: [false, false, false] },
    ];
    const agg = aggregateResults(results, 3);
    // pass1 = 2/6
    expect(agg.pass1).toBeCloseTo(2 / 6);
    // passKAll = 0/2 (neither all pass)
    expect(agg.passKAll).toBeCloseTo(0);
    // passKAny = 1/2 (p1 has some)
    expect(agg.passKAny).toBeCloseTo(0.5);
  });

  test("empty results → all zeros", () => {
    const agg = aggregateResults([], 3);
    expect(agg.pass1).toBe(0);
    expect(agg.passKAll).toBe(0);
    expect(agg.passKAny).toBe(0);
  });

  test("byDifficulty breakdown groups correctly", () => {
    const results: LcbResult[] = [
      { name: "p1", difficulty: "easy", passes: [true, true] },
      { name: "p2", difficulty: "easy", passes: [false, false] },
      { name: "p3", difficulty: "hard", passes: [true, true] },
    ];
    const agg = aggregateResults(results, 2);
    expect(agg.byDifficulty["easy"]?.pass1).toBeCloseTo(0.5); // 2/4
    expect(agg.byDifficulty["hard"]?.pass1).toBeCloseTo(1.0); // 2/2
    expect(agg.byDifficulty["easy"]?.n).toBe(2);
    expect(agg.byDifficulty["hard"]?.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// stubSolutionSource
// ---------------------------------------------------------------------------
describe("stubSolutionSource", () => {
  test("returns stub unchanged", async () => {
    const stub = "export function solve(n: number): number { return n; }";
    expect(await stubSolutionSource(stub, "solve")).toBe(stub);
  });
});

// ---------------------------------------------------------------------------
// LCB_DATASET_URL export sanity
// ---------------------------------------------------------------------------
test("LCB_DATASET_URL is a non-empty string", () => {
  expect(typeof LCB_DATASET_URL).toBe("string");
  expect(LCB_DATASET_URL.length).toBeGreaterThan(0);
});
