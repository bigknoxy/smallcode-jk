import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { computeEditableSet, pinNeighborsIntoContext } from "../src/agent/target-set.ts";
import type { ContextChunk } from "../src/context/types.ts";

// The editable set = the pinned primary target + the source files it directly
// imports (1 hop, resolvable, repo-local, non-test). This is the bounded,
// wander-safe neighborhood a multi-file fix is allowed to touch. Verified
// against the real receipt fixture: src/index.js imports ./money.js.
const FIXTURE = join(import.meta.dir, "..", "evals", "fixtures", "multifile-receipt_1");

describe("computeEditableSet — bounded import neighborhood", () => {
  it("includes the primary target and its direct local import", async () => {
    const set = await computeEditableSet("src/index.js", FIXTURE);
    expect(set).toEqual(["src/index.js", "src/money.js"]);
  });

  it("primary is always first (index 0 = the pinned target)", async () => {
    const set = await computeEditableSet("src/index.js", FIXTURE);
    expect(set[0]).toBe("src/index.js");
  });

  it("a leaf module with no local imports yields just itself", async () => {
    const set = await computeEditableSet("src/money.js", FIXTURE);
    expect(set).toEqual(["src/money.js"]);
  });

  it("returns just the primary when the target does not exist", async () => {
    const set = await computeEditableSet("src/nope.js", FIXTURE);
    expect(set).toEqual(["src/nope.js"]);
  });

  it("caps the neighborhood size for wander-safety", async () => {
    const set = await computeEditableSet("src/index.js", FIXTURE, 1);
    // maxNeighbors=1 → primary + at most 1 neighbor.
    expect(set.length).toBeLessThanOrEqual(2);
    expect(set[0]).toBe("src/index.js");
  });
});

describe("pinNeighborsIntoContext — neighbors are visible + pinned", () => {
  const readFile = async (p: string): Promise<string | null> => {
    const f = Bun.file(join(FIXTURE, p));
    return (await f.exists()) ? f.text() : null;
  };

  it("adds a missing neighbor as a full pinned chunk", async () => {
    const chunks: ContextChunk[] = [
      { filePath: "src/index.js", startLine: 1, endLine: 9, content: "// primary", estimatedTokens: 5, pinned: true },
    ];
    await pinNeighborsIntoContext(chunks, ["src/index.js", "src/money.js"], readFile);
    const money = chunks.find((c) => c.filePath === "src/money.js");
    expect(money?.pinned).toBe(true);
    expect(money?.content).toContain("toFixed");
  });

  it("replaces a partial/windowed neighbor chunk with the full pinned file", async () => {
    const chunks: ContextChunk[] = [
      { filePath: "src/index.js", startLine: 1, endLine: 9, content: "// primary", estimatedTokens: 5, pinned: true },
      { filePath: "src/money.js", startLine: 2, endLine: 2, content: "  return partial", estimatedTokens: 2 },
    ];
    await pinNeighborsIntoContext(chunks, ["src/index.js", "src/money.js"], readFile);
    const moneyChunks = chunks.filter((c) => c.filePath === "src/money.js");
    expect(moneyChunks).toHaveLength(1); // the partial was replaced, not duplicated
    expect(moneyChunks[0]!.pinned).toBe(true);
    expect(moneyChunks[0]!.content).toContain("formatUSD"); // full file, not the window
  });

  it("skips the primary (index 0) — it is already pinned by the builder", async () => {
    const chunks: ContextChunk[] = [
      { filePath: "src/index.js", startLine: 1, endLine: 9, content: "// primary", estimatedTokens: 5, pinned: true },
    ];
    await pinNeighborsIntoContext(chunks, ["src/index.js"], readFile);
    expect(chunks.filter((c) => c.filePath === "src/index.js")).toHaveLength(1);
  });
});
