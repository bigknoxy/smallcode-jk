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

// ---------------------------------------------------------------------------
// scoreFiles — explicit path-mention dominates a partial-match decoy pile.
// ---------------------------------------------------------------------------

describe("scoreFiles — explicit path mention", () => {
  it("a file named verbatim in the query outranks a big partial-match decoy", () => {
    // The target: small file, few symbols — named explicitly in the query.
    const target = makeFile("src/cli/args.ts", [makeSymbol("parseArgs")]);
    // A decoy that accumulates many partial substring hits on common query
    // words ("value", "token", "flag") across a dozen symbols — the exact shape
    // that buried args.ts at rank 36 before the path-mention boost.
    const decoy = makeFile(
      "src/verify/oracle.ts",
      ["tokenValue", "flagValue", "tokenFlag", "valueToken", "flagToken", "valueFlag"].map((n) =>
        makeSymbol(n),
      ),
    );
    const scored = scoreFiles(
      [decoy, target],
      "In src/cli/args.ts, parseArgs drops a negative-number token that should be captured as the flag value",
    );
    expect(scored[0]!.fileMap.path).toBe("src/cli/args.ts");
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  it("does not boost when the query names no path (bare-symbol query unaffected)", () => {
    const a = makeFile("src/a.ts", [makeSymbol("wrapText")]);
    const b = makeFile("src/b.ts", [makeSymbol("other")]);
    // No path token in the query → PATH_MENTION_WEIGHT never applies; identical
    // to the common-case ranking above.
    const scored = scoreFiles([a, b], "fix wrapText bug");
    expect(scored[0]!.score).toBe(16);
  });

  it("a bare word matching part of a path does not trigger the path boost", () => {
    // "args" alone is not the file's full path — only the +2 path-token bonus
    // applies, never the dominant PATH_MENTION_WEIGHT.
    const f = makeFile("src/cli/args.ts", [makeSymbol("parseArgs")]);
    const scored = scoreFiles([f], "fix the args handling");
    expect(scored[0]!.score).toBeLessThan(100); // nowhere near the 1000 boost
  });
});

// ---------------------------------------------------------------------------
// scoreFiles — "defines over uses": a file NAMED for the concept (the definer)
// outranks a big orchestration file that merely USES it via partial matches.
// Regression guard for the real dogfood failure (operator-mutation task locked
// onto loop.ts, the caller, not operator-mutation.ts, the definer).
// ---------------------------------------------------------------------------

describe("scoreFiles — defines over uses (basename definer signal)", () => {
  it("ranks the file NAMED for the concept above a bigger file that only uses it", () => {
    // Definer: small module literally named for the mechanism, few symbols.
    const definer = makeFile("src/repair/operator-mutation.ts", [
      makeSymbol("enumerateComparisonMutations"),
      makeSymbol("OperatorMutation", "class"),
    ]);
    // User/orchestration: a big file that references the mechanism across many
    // symbols, accumulating partial-substring hits on the task's common words.
    const user = makeFile(
      "src/agent/loop.ts",
      [
        "runOperatorMutationRepair",
        "runLiteralRepair",
        "runStatementRepair",
        "pristineTargetContent",
        "readFailureWindow",
        "parseToolCalls",
      ].map((n) => makeSymbol(n)),
    );
    const scored = scoreFiles(
      [user, definer],
      "Add support for flipping multiplicative operators in the operator-mutation repair pass",
    );
    expect(scored[0]!.fileMap.path).toBe("src/repair/operator-mutation.ts");
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  it("gives a compound (two-token) basename match a bonus over a single-token match", () => {
    const compound = makeFile("src/repair/read-after-delete.ts", [makeSymbol("buildHint")]);
    const single = makeFile("src/repair/delete.ts", [makeSymbol("buildHint")]);
    const scored = scoreFiles(
      [single, compound],
      "generate the read after delete hint that tells the model to reorder",
    );
    expect(scored[0]!.fileMap.path).toBe("src/repair/read-after-delete.ts");
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  it("does not fire on generic structural basename tokens (index/file/utils)", () => {
    // A barrel named index.ts must NOT get a definer boost just because the task
    // sentence contains the word "index".
    const barrel = makeFile("src/agent/index.ts", [makeSymbol("reExported")]);
    const real = makeFile("src/agent/carousel.ts", [makeSymbol("runCarousel")]);
    const scored = scoreFiles([barrel, real], "fix the carousel index visitation order");
    // carousel.ts gets the definer boost; index.ts does not (index is generic).
    expect(scored[0]!.fileMap.path).toBe("src/agent/carousel.ts");
  });

  it("an explicit path mention still dominates the basename definer signal", () => {
    // If the task NAMES a path, that file wins even if a decoy is named for the
    // concept — PATH_MENTION_WEIGHT stays an order of magnitude above basename.
    const named = makeFile("src/cli/args.ts", [makeSymbol("parseArgs")]);
    const conceptNamed = makeFile("src/repair/operator-mutation.ts", [makeSymbol("x")]);
    const scored = scoreFiles(
      [conceptNamed, named],
      "In src/cli/args.ts, fix the operator mutation parsing",
    );
    expect(scored[0]!.fileMap.path).toBe("src/cli/args.ts");
  });
});

// ---------------------------------------------------------------------------
// scoreFiles — partial-match cap: a big file's unbounded partial-substring pile
// can no longer swamp a smaller, more relevant file.
// ---------------------------------------------------------------------------

describe("scoreFiles — partial-match cap", () => {
  it("caps the aggregate partial-substring score a single file can earn", () => {
    // 20 symbols each partial-matching "repair" → uncapped this is 20*4=80; the
    // cap holds it to a bounded contribution so it can't dwarf a real target.
    const bigDecoy = makeFile(
      "src/agent/orchestrate.ts",
      Array.from({ length: 20 }, (_, i) => makeSymbol(`repairStep${i}`)),
    );
    const scored = scoreFiles([bigDecoy], "run the repair");
    // Cap (12) + no path/exact/basename signal here → well under the uncapped 80.
    expect(scored[0]!.score).toBeLessThanOrEqual(12);
  });

  it("exact symbol matches remain uncapped (definer with exact hit still wins)", () => {
    const exact = makeFile("src/x.ts", [makeSymbol("repair")]); // exact "repair" = 15 + 1
    const partials = makeFile(
      "src/y.ts",
      Array.from({ length: 20 }, (_, i) => makeSymbol(`repairThing${i}`)),
    );
    const scored = scoreFiles([partials, exact], "run the repair");
    expect(scored[0]!.fileMap.path).toBe("src/x.ts");
    expect(scored[0]!.score).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// scoreFiles — scripts/ deprioritized as edit targets (dev tooling, not the
// mechanism definition).
// ---------------------------------------------------------------------------

describe("scoreFiles — scripts deprioritization", () => {
  it("flags a scripts/ path as low-priority for target selection", () => {
    expect(isLowPriorityTargetPath("scripts/compare-runs.ts")).toBe(true);
  });

  it("ranks a src definer above a scripts file named for the same concept", () => {
    const src = makeFile("src/improve/fingerprint.ts", [makeSymbol("fingerprintDiff")]);
    const script = makeFile("scripts/fingerprint.ts", [makeSymbol("fingerprintDiff")]);
    const scored = scoreFiles([script, src], "fix the fingerprint diff");
    expect(scored[0]!.fileMap.path).toBe("src/improve/fingerprint.ts");
  });
});
