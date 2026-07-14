import { describe, expect, it } from "bun:test";
import {
  computeSemanticScores,
  cosine,
  embedFileIndex,
  fileProfile,
  SEMANTIC_THRESHOLD,
  SEMANTIC_WEIGHT,
  type EmbedFn,
} from "../src/context/semantic.ts";
import type { CodeSymbol, FileMap } from "../src/context/types.ts";

function sym(name: string, signature?: string): CodeSymbol {
  return { name, kind: "function", line: 1, endLine: 5, ...(signature ? { signature } : {}) };
}
function file(path: string, names: string[]): FileMap {
  return { path, language: "typescript", symbols: names.map((n) => sym(n)), lineCount: 20, sizeBytes: 400 };
}

describe("cosine", () => {
  it("is 1 for identical vectors, 0 for orthogonal", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("returns 0 for length mismatch or degenerate vectors", () => {
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});

describe("fileProfile", () => {
  it("includes the path and dedups symbol names, capped at 60", () => {
    const p = fileProfile(file("src/a/carousel.ts", ["runCarousel", "runCarousel", "nextFocus"]));
    expect(p).toContain("src/a/carousel.ts");
    // dedup: runCarousel appears once
    expect(p.split("runCarousel").length - 1).toBe(1);
    expect(p).toContain("nextFocus");
  });
  it("caps a huge symbol list", () => {
    const names = Array.from({ length: 200 }, (_, i) => `sym${i}`);
    const p = fileProfile(file("src/big.ts", names));
    expect(p.split("\n").length).toBeLessThanOrEqual(61); // path + 60
  });
});

describe("computeSemanticScores", () => {
  const files = [file("src/target.ts", ["doThing"]), file("src/other.ts", ["misc"])];

  // Fake embedder: query = [1,0]; target doc = [1,0] (cosine 1 → above threshold),
  // other doc = [0,1] (cosine 0 → below threshold). First call embeds the query.
  const fakeEmbed: EmbedFn = async (texts) =>
    texts.map((t) =>
      t.startsWith("search_query:") ? [1, 0] : t.includes("target.ts") ? [1, 0] : [0, 1],
    );

  it("scores an above-threshold file into (0, SEMANTIC_WEIGHT] and drops below-threshold ones", async () => {
    const scores = await computeSemanticScores("do the thing", files, fakeEmbed);
    expect(scores.has("src/target.ts")).toBe(true);
    expect(scores.get("src/target.ts")).toBeCloseTo(SEMANTIC_WEIGHT); // cosine 1 → full weight
    expect(scores.has("src/other.ts")).toBe(false); // cosine 0 ≤ threshold
  });

  it("scales linearly above the floor", async () => {
    // Query [1,0]; doc unit vector whose cosine with [1,0] is exactly the
    // midpoint between the threshold and 1 → boost should be half the weight.
    const mid = (SEMANTIC_THRESHOLD + 1) / 2;
    const midEmbed: EmbedFn = async (texts) =>
      texts.map((t) => (t.startsWith("search_query:") ? [1, 0] : [mid, Math.sqrt(1 - mid * mid)]));
    const scores = await computeSemanticScores("q", [file("src/target.ts", ["x"])], midEmbed);
    expect(scores.get("src/target.ts")).toBeCloseTo(SEMANTIC_WEIGHT * 0.5, 1);
  });

  it("reuses precomputed doc vectors (query-independent index)", async () => {
    let embedCalls = 0;
    const counting: EmbedFn = async (texts) => {
      embedCalls++;
      return texts.map((t) => (t.startsWith("search_query:") ? [1, 0] : [1, 0]));
    };
    const docVecs = await embedFileIndex(files, counting); // 1 call (batch)
    expect(embedCalls).toBe(1);
    await computeSemanticScores("q", files, counting, docVecs ?? undefined); // only the query
    expect(embedCalls).toBe(2); // NOT re-embedding the docs
  });

  it("degrades to an empty map when the embedder throws (never breaks a run)", async () => {
    const broken: EmbedFn = async () => {
      throw new Error("embedder down");
    };
    const scores = await computeSemanticScores("q", files, broken);
    expect(scores.size).toBe(0);
  });

  it("returns an empty map for no files", async () => {
    expect((await computeSemanticScores("q", [], fakeEmbed)).size).toBe(0);
  });
});
