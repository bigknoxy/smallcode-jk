import { describe, expect, it } from "bun:test";
import { buildContext } from "../src/context/builder.ts";
import { scoreFiles } from "../src/context/scorer.ts";
import { charsForTokens, chunkTokens, estimateTokens } from "../src/context/tokens.ts";
import type { CodeSymbol, ContextChunk, FileMap, RepoMap } from "../src/context/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSymbol(
  name: string,
  kind: CodeSymbol["kind"] = "function",
  line = 1,
  endLine = 10,
  signature?: string,
): CodeSymbol {
  return { name, kind, line, endLine, signature };
}

function makeFile(path: string, symbols: CodeSymbol[] = [], lineCount = 20): FileMap {
  return {
    path,
    language: "typescript",
    symbols,
    lineCount,
    sizeBytes: lineCount * 40,
  };
}

function makeRepoMap(files: FileMap[], root = "/tmp/fake-repo"): RepoMap {
  return {
    root,
    files,
    totalSymbols: files.reduce((n, f) => n + f.symbols.length, 0),
    builtAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// tokens.ts
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 1 for empty string (minimum)", () => {
    expect(estimateTokens("")).toBe(1);
  });

  it("estimates tokens for short text in correct range", () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    const result = estimateTokens("hello world");
    expect(result).toBe(3);
    expect(result).toBeGreaterThanOrEqual(1);
  });

  it("returns ceil(length/4) for normal strings", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4/4 = 1
    expect(estimateTokens("abcde")).toBe(2); // 5/4 = 1.25 → 2
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("charsForTokens is inverse of estimateTokens formula", () => {
    expect(charsForTokens(10)).toBe(40);
    expect(charsForTokens(1)).toBe(4);
  });

  it("chunkTokens delegates to estimateTokens on content", () => {
    const chunk: ContextChunk = {
      filePath: "src/foo.ts",
      startLine: 1,
      endLine: 5,
      content: "abcd", // 4 chars → 1 token
      estimatedTokens: 0, // will be ignored — chunkTokens recomputes
    };
    expect(chunkTokens(chunk)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scorer.ts
// ---------------------------------------------------------------------------

describe("scoreFiles", () => {
  it("ranks exact symbol name match highest", () => {
    const fileWithExact = makeFile("src/auth/login.ts", [makeSymbol("authenticate")]);
    const fileWithPartial = makeFile("src/auth/user.ts", [makeSymbol("authHelper")]);
    const fileNoMatch = makeFile("src/utils/string.ts", [makeSymbol("trim")]);

    const results = scoreFiles([fileNoMatch, fileWithPartial, fileWithExact], "authenticate");

    expect(results[0]?.fileMap.path).toBe("src/auth/login.ts");
  });

  it("ranks path match higher than no match", () => {
    const filePathMatch = makeFile("src/authenticate/utils.ts", [makeSymbol("helper")]);
    const fileNoMatch = makeFile("src/random/stuff.ts", [makeSymbol("doThing")]);

    const results = scoreFiles([fileNoMatch, filePathMatch], "authenticate");

    expect(results[0]?.fileMap.path).toBe("src/authenticate/utils.ts");
  });

  it("handles empty query gracefully (no crash, returns all files)", () => {
    const files = [
      makeFile("src/foo.ts", [makeSymbol("foo")]),
      makeFile("src/bar.ts", [makeSymbol("bar")]),
    ];

    expect(() => scoreFiles(files, "")).not.toThrow();
    const results = scoreFiles(files, "");
    expect(results).toHaveLength(2);
  });

  it("handles empty file list", () => {
    expect(scoreFiles([], "anything")).toHaveLength(0);
  });

  it("gives function/method kind a +1 boost over non-function symbols", () => {
    // Both have a partial match on "process" — but one is a function, one is a type
    const fileFunc = makeFile("src/a.ts", [makeSymbol("processData", "function")]);
    const fileType = makeFile("src/b.ts", [makeSymbol("processData", "type")]);

    const results = scoreFiles([fileType, fileFunc], "process");

    expect(results[0]?.fileMap.path).toBe("src/a.ts");
  });

  it("zero-scored files are included but sorted last", () => {
    const fileMatch = makeFile("src/auth.ts", [makeSymbol("login")]);
    const fileNoMatch = makeFile("src/noop.ts", [makeSymbol("zzz")]);

    const results = scoreFiles([fileNoMatch, fileMatch], "login");

    expect(results[results.length - 1]?.fileMap.path).toBe("src/noop.ts");
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// builder.ts — using includeSymbolsOnly to avoid file I/O in most tests
// ---------------------------------------------------------------------------

describe("buildContext", () => {
  it("returns empty bundle for empty repoMap", async () => {
    const repoMap = makeRepoMap([]);
    const bundle = await buildContext(repoMap, "anything", {
      repoRoot: "/tmp/fake",
      tokenBudget: 4096,
    });

    expect(bundle.chunks).toHaveLength(0);
    expect(bundle.totalTokens).toBe(0);
    expect(bundle.truncated).toBe(false);
    expect(bundle.query).toBe("anything");
  });

  it("returns truncated=true with tiny effective budget (symbol-only mode)", async () => {
    const files = [
      makeFile("src/foo.ts", [makeSymbol("doStuff")], 50),
      makeFile("src/bar.ts", [makeSymbol("doMore")], 50),
      makeFile("src/baz.ts", [makeSymbol("doEven")], 50),
    ];
    const repoMap = makeRepoMap(files);

    // reserveTokens=2040 leaves only ~8 tokens effective budget
    const bundle = await buildContext(repoMap, "doStuff", {
      repoRoot: "/tmp/fake",
      tokenBudget: 2048,
      reserveTokens: 2040,
      includeSymbolsOnly: true,
    });

    expect(bundle.truncated).toBe(true);
    expect(bundle.totalTokens).toBeLessThanOrEqual(2048);
  });

  it("returns truncated=false with large budget for small symbol-only repo", async () => {
    const files = [makeFile("src/foo.ts", [makeSymbol("doStuff")], 10)];
    const repoMap = makeRepoMap(files);

    const bundle = await buildContext(repoMap, "doStuff", {
      repoRoot: "/tmp/fake",
      tokenBudget: 16384,
      includeSymbolsOnly: true,
    });

    expect(bundle.truncated).toBe(false);
    expect(bundle.totalTokens).toBeGreaterThan(0);
    expect(bundle.totalTokens).toBeLessThanOrEqual(16384);
  });

  it("never exceeds tokenBudget — property-based: various budgets (symbol-only)", async () => {
    const files = [
      makeFile("src/a.ts", [makeSymbol("alpha"), makeSymbol("beta")], 30),
      makeFile("src/b.ts", [makeSymbol("gamma")], 20),
      makeFile("src/c.ts", [makeSymbol("delta"), makeSymbol("epsilon")], 40),
    ];
    const repoMap = makeRepoMap(files);

    const budgets = [2100, 2200, 2500, 4000, 8000, 16000];

    for (const tokenBudget of budgets) {
      const bundle = await buildContext(repoMap, "alpha", {
        repoRoot: "/tmp/fake",
        tokenBudget,
        includeSymbolsOnly: true,
      });
      expect(bundle.totalTokens).toBeLessThanOrEqual(tokenBudget);
      expect(bundle.tokenBudget).toBe(tokenBudget);
    }
  });

  it("includeSymbolsOnly=true does not call Bun.file (no disk reads)", async () => {
    // Patch Bun.file to throw — should never be called in symbol-only mode.
    const origBunFile = Bun.file.bind(Bun);
    let fileReadAttempted = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bunGlobal = Bun as unknown as Record<string, unknown>;
    bunGlobal["file"] = (path: string) => {
      fileReadAttempted = true;
      throw new Error(`Unexpected Bun.file call for: ${path}`);
    };

    try {
      const files = [makeFile("src/foo.ts", [makeSymbol("myFunc")], 10)];
      const repoMap = makeRepoMap(files);

      const bundle = await buildContext(repoMap, "myFunc", {
        repoRoot: "/tmp/fake",
        tokenBudget: 8192,
        includeSymbolsOnly: true,
      });

      expect(fileReadAttempted).toBe(false);
      expect(bundle.chunks).toHaveLength(1);
    } finally {
      bunGlobal["file"] = origBunFile;
    }
  });

  it("bundle query field matches the query passed in", async () => {
    const repoMap = makeRepoMap([makeFile("src/x.ts", [makeSymbol("x")])]);
    const bundle = await buildContext(repoMap, "my search query", {
      repoRoot: "/tmp/fake",
      tokenBudget: 8192,
      includeSymbolsOnly: true,
    });
    expect(bundle.query).toBe("my search query");
  });

  it("tokenBudget field in bundle equals options.tokenBudget", async () => {
    const repoMap = makeRepoMap([makeFile("src/x.ts", [makeSymbol("x")])]);
    const bundle = await buildContext(repoMap, "x", {
      repoRoot: "/tmp/fake",
      tokenBudget: 5000,
      includeSymbolsOnly: true,
    });
    expect(bundle.tokenBudget).toBe(5000);
  });
});
