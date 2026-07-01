import { describe, expect, it } from "bun:test";
import { isLowPriorityTargetPath, scoreFiles } from "../src/context/scorer.ts";
import type { CodeSymbol, FileMap } from "../src/context/types.ts";

// ---------------------------------------------------------------------------
// isLowPriorityTargetPath — path-shape classification only, no scoring.
// ---------------------------------------------------------------------------

describe("isLowPriorityTargetPath", () => {
  for (const p of [
    "evals/fixtures/x/src/a.ts",
    "test/foo.test.ts",
    "examples/bar.ts",
    "vendor/baz.ts",
    "__fixtures__/thing.ts",
    "__mocks__/thing.ts",
    "pkg/testdata/thing.ts",
    "pkg/third_party/thing.ts",
    "eval/some/file.ts",
  ]) {
    it(`flags ${p}`, () => {
      expect(isLowPriorityTargetPath(p)).toBe(true);
    });
  }

  for (const p of [
    "src/context/tokens.ts",
    "src/edit/applier.ts",
    "verify/oracle.ts",
    "src/vendorized.ts", // "vendor" as substring of a segment, not a segment itself
  ]) {
    it(`does not flag ${p}`, () => {
      expect(isLowPriorityTargetPath(p)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// scoreFiles — behavioral: a fixture twin never outranks the real source.
// ---------------------------------------------------------------------------

function makeSymbol(name: string, kind: CodeSymbol["kind"] = "function"): CodeSymbol {
  return { name, kind, line: 1, endLine: 10 };
}

function makeFile(path: string, symbols: CodeSymbol[]): FileMap {
  return { path, language: "typescript", symbols, lineCount: 20, sizeBytes: 800 };
}

describe("scoreFiles — low-priority path deprioritization", () => {
  it("ranks real source above a lexically-identical fixture twin", () => {
    const real = makeFile("src/real.ts", [makeSymbol("wrapText")]);
    const fixture = makeFile("evals/fixtures/x/src/real.ts", [makeSymbol("wrapText")]);

    const scored = scoreFiles([fixture, real], "fix wrapText bug");

    expect(scored[0]!.fileMap.path).toBe("src/real.ts");
    expect(scored[1]!.fileMap.path).toBe("evals/fixtures/x/src/real.ts");
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  it("applies the penalty only when score > 0 (never resurrects a zero-score file)", () => {
    // No query token appears anywhere in this path or its (empty) symbol list,
    // so the file scores zero both before and after the low-priority penalty.
    const fixture = makeFile("vendor/unrelated.ts", []);
    const scored = scoreFiles([fixture], "wrapText bug");
    expect(scored[0]!.score).toBe(0);
  });

  it("leaves scoring unchanged when no low-priority paths are present (common case)", () => {
    const a = makeFile("src/a.ts", [makeSymbol("wrapText")]);
    const b = makeFile("src/b.ts", [makeSymbol("other")]);
    const scored = scoreFiles([a, b], "fix wrapText bug");
    // Exact symbol match weight (15) + function kind boost (1); path itself has
    // no query-token substring so no +2 path bonus here.
    expect(scored[0]!.fileMap.path).toBe("src/a.ts");
    expect(scored[0]!.score).toBe(16);
    expect(scored[1]!.score).toBe(0);
  });
});
