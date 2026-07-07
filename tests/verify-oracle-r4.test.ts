import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLoadError, captureTestBaseline, runTieredOracle } from "../src/verify/oracle.ts";

describe("R4 hasLoadError — load/compile signatures only", () => {
  test("detects missing module", () => {
    expect(hasLoadError("error: Cannot find module 'std/strings'")).toBe(true);
  });
  test("detects syntax/parse errors", () => {
    expect(hasLoadError("SyntaxError: Unexpected token")).toBe(true);
    expect(hasLoadError("Transpilation failed")).toBe(true);
  });
  test("detects a missing export (the dogfood 2026-07-07 wilsonCI red)", () => {
    // A test importing a not-yet-implemented symbol. This must read as a
    // compile/load error so the operator/statement repair passes SKIP it —
    // no operator flip in the target can conjure a missing export.
    expect(hasLoadError("SyntaxError: Export named 'wilsonCI' not found in module")).toBe(true);
    expect(hasLoadError("Export named 'foo' not found in module '/x/y.ts'")).toBe(true);
  });
  test("does NOT fire on a normal assertion failure", () => {
    expect(hasLoadError("(fail) adds numbers\nExpected: 5\nReceived: 6\n 1 fail")).toBe(false);
  });
  test("does NOT fire on green output", () => {
    expect(hasLoadError(" 5 pass\n 0 fail")).toBe(false);
  });
});

describe("R4 introduced-load-error = hard regression (the dogfood bug)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function scaffold(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "r4-"));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }
    return dir;
  }

  test("baseline RED that LOADS; edit breaks the import (red-count DROPS) ⇒ regressed:true", async () => {
    // Baseline: module loads fine but its tests fail (the slugify situation —
    // several red, suite compiles). redCount > 0, loadError false.
    const dir = await scaffold({
      "src/s.ts": "export function s(x: string): string { return x; }\n",
      "tests/s.test.ts":
        'import { test, expect } from "bun:test";\nimport { s } from "../src/s.ts";\n' +
        'test("a", () => expect(s("X")).toBe("x"));\n' +
        'test("b", () => expect(s("Y")).toBe("y"));\n' +
        'test("c", () => expect(s("Z")).toBe("z"));\n',
      "package.json": '{"name":"t","type":"module"}',
    });
    const baseline = captureTestBaseline(dir);
    expect(baseline.redCount).toBeGreaterThan(0);
    expect(baseline.loadError).toBe(false);

    // The "edit": hallucinate a non-existent module. Suite no longer loads → bun
    // reports FEWER reds than baseline. Pre-R4 the count guard called this progress.
    await writeFile(
      join(dir, "src", "s.ts"),
      'import { ascii } from "std/strings";\nexport function s(x: string): string { return ascii(x); }\n',
      "utf-8",
    );

    const verdict = await runTieredOracle(dir, { baseline });
    expect(verdict.outcome).toBe("failing");
    expect(verdict.regressed).toBe(true);
    expect(verdict.newFailures?.some((f) => f.includes("build error"))).toBe(true);
    expect(verdict.feedback).toContain("BUILD ERROR");
  });

  test("baseline ALREADY a load error ⇒ a still-broken edit is NOT a new regression", async () => {
    // Repo arrives non-loading. An edit that is also non-loading did not regress
    // anything — the load-error guard must stay silent so it doesn't thrash.
    const dir = await scaffold({
      "src/s.ts": 'import { x } from "nope/missing";\nexport const s = x;\n',
      "tests/s.test.ts": 'import { s } from "../src/s.ts";\nimport { test } from "bun:test";\ntest("t", () => s);\n',
      "package.json": '{"name":"t","type":"module"}',
    });
    const baseline = captureTestBaseline(dir);
    expect(baseline.loadError).toBe(true);

    const verdict = await runTieredOracle(dir, { baseline });
    // Still failing, but the load-error guard did not manufacture a fresh regression.
    expect(verdict.newFailures?.some((f) => f.includes("build error"))).toBe(false);
  });
});
