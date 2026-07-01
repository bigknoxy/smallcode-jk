import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkRepo } from "../src/context/walker.ts";

// ---------------------------------------------------------------------------
// Retrieval scope regression guard.
//
// walkRepo() must never index tooling/vendored/generated directories — most
// critically `.claude/` (which can contain a full nested git worktree copy
// of the repo). Indexing a phantom copy corrupts target selection: retrieval
// can pin an edit target inside `.claude/worktrees/**` instead of the real
// file, and the target-lock then rejects edits to the real file (deadlock).
//
// This test builds a throwaway repo with node_modules/, .claude/, dist/, a
// .gitignore excluding a custom dir, and real src/ files, and asserts
// walkRepo() returns only the real files.
// ---------------------------------------------------------------------------

describe("walkRepo — ignores tooling/vendored/generated dirs + honors .gitignore", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "walker-ignore-"));

    // Directories that must be excluded via DEFAULT_IGNORE.
    await mkdir(join(root, "node_modules", "some-pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "some-pkg", "index.js"), "module.exports = 1;");

    await mkdir(join(root, ".claude", "worktrees", "phantom-copy", "src"), { recursive: true });
    await writeFile(
      join(root, ".claude", "worktrees", "phantom-copy", "src", "phantom.ts"),
      "export const phantom = 1;",
    );

    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "bundle.js"), "console.log('built');");

    // .gitignore-only exclusion (not in DEFAULT_IGNORE).
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated", "codegen.ts"), "export const g = 1;");
    await writeFile(join(root, ".gitignore"), "generated/\n*.snap\n");

    await writeFile(join(root, "leftover.snap"), "snapshot data");

    // Real source that must survive.
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "real.ts"), "export function real() { return 1; }");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("excludes node_modules, .claude, dist, and .gitignore-matched paths; keeps real src files", async () => {
    const repoMap = await walkRepo({ root }, Date.now());
    const paths = repoMap.files.map((f) => f.path).sort();

    expect(paths).toEqual(["src/real.ts"]);
    expect(paths.some((p) => p.includes(".claude"))).toBe(false);
    expect(paths.some((p) => p.includes("phantom"))).toBe(false);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("generated/"))).toBe(false);
    expect(paths.some((p) => p.endsWith(".snap"))).toBe(false);
  });

  it("composes a caller-supplied ignore list with DEFAULT_IGNORE rather than replacing it", async () => {
    // Even though the caller only supplies a custom pattern, `.claude` and
    // `node_modules` must still be excluded via the defaults.
    const repoMap = await walkRepo({ root, ignore: ["nonexistent-dir"] }, Date.now());
    const paths = repoMap.files.map((f) => f.path);

    expect(paths).toEqual(["src/real.ts"]);
  });
});
