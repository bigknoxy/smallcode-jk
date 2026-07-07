import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { buildContext, walkRepo } from "../src/context/index.ts";

// ---------------------------------------------------------------------------
// Multi-file decoy disambiguation (file-pin tie-breaker).
//
// The dequal fixture ships THREE source files that all export a dequal-family
// function — src/index.js (the REAL target; the Array-branch bug), src/alts.js
// (decoy variants v227/v255/…), and src/lite.js (also `export function dequal`).
// Lexical scoring ties across them on the shared "dequal"/"array"/"equal"
// tokens, so the pin loop could aim at a decoy. The tests import ../src/index.js
// only, so that file is the correct edit target.
//
// These tests drive the REAL retrieval path (walkRepo → buildContext) on the
// on-disk fixtures, so they validate exactly what the eval harness runs.
// ---------------------------------------------------------------------------

const FIXTURES = resolve(import.meta.dir, "../evals/fixtures");

async function pinFor(fixture: string, query: string): Promise<string | undefined> {
  const root = `${FIXTURES}/${fixture}`;
  const repoMap = await walkRepo({ root }, Date.now());
  const bundle = await buildContext(repoMap, query, { repoRoot: root, tokenBudget: 8192 });
  return bundle.targetFile?.path;
}

describe("multi-file decoy disambiguation: dequal", () => {
  // The buggy Array branch is described by behaviour; the query names the lib.
  const DEQUAL_QUERY =
    "the deep-equal dequal function wrongly reports arrays of different lengths " +
    "as equal; fix the broken array-comparison logic";

  it("pins src/index.js (the file the tests import), NOT alts.js or lite.js", async () => {
    const pin = await pinFor("realrepo-dequal-multifile_1", DEQUAL_QUERY);
    expect(pin).toBe("src/index.js");
  });

  it("does not pin a decoy even when the query token matches all three files", async () => {
    // "dequal" appears as a symbol in index.js AND lite.js and as a recursive
    // call in alts.js — a pure lexical tie. The import-graph tie-breaker is the
    // only thing that disambiguates.
    const pin = await pinFor("realrepo-dequal-multifile_1", "fix the dequal bug");
    expect(pin).not.toBe("src/alts.js");
    expect(pin).not.toBe("src/lite.js");
    expect(pin).toBe("src/index.js");
  });
});

describe("barrel-wrapper disambiguation: csv-quote", () => {
  // src/index.js is a thin wrapper: it imports parseLine from src/lexer.js and
  // defines `parse` (map parseLine over lines). The bug + the fix live in
  // src/lexer.js's parseLine. But the tests import ../src/index.js, so the
  // test-import tie-breaker used to front-load index.js ahead of lexer.js —
  // EVEN THOUGH the query names src/lexer.js verbatim (dominant PATH_MENTION
  // score). The tie-breaker must stay a TRUE tie-break: never demote the
  // uniquely-highest-scored, path-named winner below a lower-scored barrel.
  const CSV_QUERY =
    "In src/lexer.js, fix parseLine() to handle RFC-4180 escaped double-quotes " +
    'inside a quoted field (a "" pair is one literal ")';

  it("pins src/lexer.js (defines the buggy parseLine), NOT the test-imported src/index.js wrapper", async () => {
    const pin = await pinFor("realrepo-csv-quote_1", CSV_QUERY);
    expect(pin).toBe("src/lexer.js");
  });
});

describe("no regression on existing fixtures", () => {
  it("single-file klona-array still pins src/index.js", async () => {
    const pin = await pinFor(
      "realrepo-klona-array_1",
      "fix the klona Array branch off-by-one so index 0 is cloned",
    );
    expect(pin).toBe("src/index.js");
  });

  it("single-file mri-flags still pins src/index.js", async () => {
    const pin = await pinFor(
      "realrepo-mri-flags_1",
      "fix the inverted next-arg lookahead on the val= line in the mri parser",
    );
    expect(pin).toBe("src/index.js");
  });

  it("multi-file edit-rel-bigfile-wrap pins the wrap.ts file the query+tests target", async () => {
    // Four source files, each imported by its own test. The query names wrap,
    // so lexical scoring already favours wrap.ts; the tie-breaker (which prefers
    // ANY test-imported file) must not demote it — wrap.ts IS test-imported.
    const pin = await pinFor(
      "edit-rel-bigfile-wrap_1",
      "fix the wrapText width comparison in the wrap module",
    );
    expect(pin).toBe("src/wrap.ts");
  });
});
