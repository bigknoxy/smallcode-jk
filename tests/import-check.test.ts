import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNewImports,
  diffNewSpecifiers,
  extractImportSpecifiers,
  formatImportRejection,
  isBuiltinSpecifier,
  isRelativeSpecifier,
  packageRootOf,
  resolveSpecifier,
} from "../src/verify/import-check.ts";

// ---------------------------------------------------------------------------
// Lever 2 — static import-resolution gate. Kill hallucinated imports (the
// dogfood `std/strings` failure) before they cost a turn.
// ---------------------------------------------------------------------------

describe("extractImportSpecifiers (pure)", () => {
  it("pulls specifiers from import/from, side-effect import, re-export, require, dynamic import", () => {
    const src = [
      'import { a } from "./local.ts";',
      'import def from "lodash";',
      'import "side-effect";',
      'export { x } from "@scope/pkg";',
      'const fs = require("node:fs");',
      'const m = await import("dynamic-mod");',
    ].join("\n");
    expect(extractImportSpecifiers(src)).toEqual([
      "./local.ts",
      "lodash",
      "side-effect",
      "@scope/pkg",
      "node:fs",
      "dynamic-mod",
    ]);
  });

  it("dedupes and preserves first-seen order", () => {
    const src = 'import "a";\nimport { x } from "a";\nimport "b";';
    expect(extractImportSpecifiers(src)).toEqual(["a", "b"]);
  });
});

describe("classification helpers (pure)", () => {
  it("recognizes builtins with and without prefixes", () => {
    expect(isBuiltinSpecifier("node:path")).toBe(true);
    expect(isBuiltinSpecifier("bun:test")).toBe(true);
    expect(isBuiltinSpecifier("fs")).toBe(true);
    expect(isBuiltinSpecifier("lodash")).toBe(false);
  });

  it("recognizes relative and absolute specifiers", () => {
    expect(isRelativeSpecifier("./x")).toBe(true);
    expect(isRelativeSpecifier("../x")).toBe(true);
    expect(isRelativeSpecifier("/abs")).toBe(true);
    expect(isRelativeSpecifier("pkg")).toBe(false);
  });

  it("computes the package-root (scope-aware)", () => {
    expect(packageRootOf("lodash/fp")).toBe("lodash");
    expect(packageRootOf("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(packageRootOf("mri")).toBe("mri");
  });
});

describe("diffNewSpecifiers (pure)", () => {
  it("returns only specifiers the edit added", () => {
    const oldS = 'import "a";\nimport "b";';
    const newS = 'import "a";\nimport "b";\nimport "c";';
    expect(diffNewSpecifiers(oldS, newS)).toEqual(["c"]);
  });

  it("does not flag a pre-existing import the edit left untouched", () => {
    const oldS = 'import "std/strings";'; // already there
    const newS = 'import "std/strings";\nexport const x = 1;';
    expect(diffNewSpecifiers(oldS, newS)).toEqual([]);
  });
});

describe("resolveSpecifier (fs-backed)", () => {
  const repo = join(tmpdir(), `import-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  it("builtins always resolve", () => {
    expect(resolveSpecifier("node:path", join(repo, "src/x.ts"), repo, new Set())).toBe(true);
  });
  it("a declared dep resolves even without node_modules installed", () => {
    expect(resolveSpecifier("mri", join(repo, "src/x.ts"), repo, new Set(["mri"]))).toBe(true);
    expect(resolveSpecifier("mri/sub", join(repo, "src/x.ts"), repo, new Set(["mri"]))).toBe(true);
  });
  it("a hallucinated bare module does not resolve", () => {
    expect(resolveSpecifier("std/strings", join(repo, "src/x.ts"), repo, new Set(["mri"]))).toBe(false);
  });
});

describe("checkNewImports (integration, real repo)", () => {
  let repo: string;
  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  async function setup(pkg: object): Promise<void> {
    repo = join(tmpdir(), `import-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify(pkg), "utf-8");
    await writeFile(join(repo, "src", "helper.ts"), "export const h = 1;\n", "utf-8");
  }

  it("flags a hallucinated import the edit introduced and lists available deps", async () => {
    await setup({ name: "t", dependencies: { mri: "^1" }, devDependencies: { "bun-types": "^1" } });
    const oldS = "export function f() { return 1; }\n";
    const newS = 'import { pad } from "std/strings";\nexport function f() { return pad(1); }\n';
    const r = await checkNewImports(oldS, newS, "src/index.ts", repo);
    expect(r.unresolved).toEqual(["std/strings"]);
    expect(r.availableDeps).toEqual(["bun-types", "mri"]);
    expect(formatImportRejection("src/index.ts", r)).toContain("std/strings");
    expect(formatImportRejection("src/index.ts", r)).toContain("mri");
  });

  it("passes a valid relative import to an existing file", async () => {
    await setup({ name: "t" });
    const oldS = "export const x = 1;\n";
    const newS = 'import { h } from "./helper.ts";\nexport const x = h;\n';
    const r = await checkNewImports(oldS, newS, "src/index.ts", repo);
    expect(r.unresolved).toEqual([]);
  });

  it("flags a relative import to a file that does NOT exist", async () => {
    await setup({ name: "t" });
    const oldS = "export const x = 1;\n";
    const newS = 'import { z } from "./nope.ts";\nexport const x = z;\n';
    const r = await checkNewImports(oldS, newS, "src/index.ts", repo);
    expect(r.unresolved).toEqual(["./nope.ts"]);
  });

  it("passes a declared bare dependency and a builtin", async () => {
    await setup({ name: "t", dependencies: { mri: "^1" } });
    const oldS = "export const x = 1;\n";
    const newS = 'import mri from "mri";\nimport { join } from "node:path";\nexport const x = mri(join("a", "b"));\n';
    const r = await checkNewImports(oldS, newS, "src/index.ts", repo);
    expect(r.unresolved).toEqual([]);
  });

  it("is a no-op when the edit added no imports", async () => {
    await setup({ name: "t" });
    const r = await checkNewImports("export const x = 1;\n", "export const x = 2;\n", "src/index.ts", repo);
    expect(r.unresolved).toEqual([]);
    expect(r.availableDeps).toEqual([]);
  });
});
