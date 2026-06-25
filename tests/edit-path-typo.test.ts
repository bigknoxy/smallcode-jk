import { describe, expect, it } from "bun:test";
import { applyBatch, flattenedPathCandidate } from "../src/edit/applier.ts";
import type { EditBlock } from "../src/edit/types.ts";

describe("flattenedPathCandidate", () => {
  it("restores dots-as-slashes for a flattened path", () => {
    expect(flattenedPathCandidate("src.stats.ts")).toBe("src/stats.ts");
    expect(flattenedPathCandidate("src.agent.loop.ts")).toBe("src/agent/loop.ts");
  });

  it("returns null when there is nothing to restore", () => {
    expect(flattenedPathCandidate("index.ts")).toBeNull(); // single dot = extension
    expect(flattenedPathCandidate("src/stats.ts")).toBeNull(); // already has slashes... still has one dot
    expect(flattenedPathCandidate("noext")).toBeNull();
    expect(flattenedPathCandidate(".gitignore")).toBeNull(); // leading dot only
  });
});

describe("applyBatch — path-typo rescue", () => {
  function full(filePath: string, replace: string): EditBlock {
    return { filePath, search: "", replace, format: "full-file" };
  }

  it("redirects a flattened new-file write onto the existing real file", async () => {
    const disk = new Map<string, string>([["src/stats.ts", "export const x = 1;\n"]]);
    const reads: string[] = [];
    const readFile = async (p: string): Promise<string | null> => {
      reads.push(p);
      return disk.has(p) ? (disk.get(p) ?? null) : null;
    };
    const writes: Array<[string, string]> = [];
    const writeFile = async (p: string, c: string): Promise<void> => {
      writes.push([p, c]);
      disk.set(p, c);
    };

    // Model typo'd the path: "src.stats.ts" instead of "src/stats.ts".
    const next = "export const x = 2;\n";
    const result = await applyBatch([full("src.stats.ts", next)], readFile, writeFile);

    expect(result.allApplied).toBe(true);
    // The write landed on the REAL file, not a stray "src.stats.ts".
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe("src/stats.ts");
    expect(disk.get("src/stats.ts")).toBe(next);
    expect(disk.has("src.stats.ts")).toBe(false);
    // And it edited an existing file (original non-empty) — so the truncation
    // guard was in force on this write.
    expect(result.results[0]?.originalContent).toBe("export const x = 1;\n");
  });

  it("leaves a genuine new file alone when no slashed variant exists", async () => {
    const disk = new Map<string, string>();
    const readFile = async (p: string): Promise<string | null> =>
      disk.has(p) ? (disk.get(p) ?? null) : null;
    const writes: Array<[string, string]> = [];
    const writeFile = async (p: string, c: string): Promise<void> => {
      writes.push([p, c]);
      disk.set(p, c);
    };

    // "my.config.ts" is a legitimate new file; "my/config.ts" does not exist.
    const content = "export default {};\n";
    const result = await applyBatch([full("my.config.ts", content)], readFile, writeFile);

    expect(result.allApplied).toBe(true);
    expect(writes[0]?.[0]).toBe("my.config.ts");
  });
});
