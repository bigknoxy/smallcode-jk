import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTestBaseline, runTieredOracle } from "../src/verify/oracle.ts";

// End-to-end oracle behavior against real `bun test` / `tsc` subprocesses (no
// Ollama). Verifies the tiering: tests authoritative, typecheck advisory fallback
// when no test covers the change, tool-missing/config-noise degrades to skipped.

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function scaffold(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oracle-it-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return dir;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    module: "esnext",
    target: "esnext",
    moduleResolution: "bundler",
  },
  include: ["src"],
});

// ===== BASELINE FIX INTEGRATION TESTS =====

test("baseline fix: pre-existing red + add passing test → solved", async () => {
  // Start with a failing test (pre-existing failure).
  const dir = await scaffold({
    "src/m.ts": "export const add = (a: number, b: number) => a - b;\n",
    "tests/pre-existing.test.ts":
      'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("pre-existing fail", () => expect(add(2, 3)).toBe(5));\n',
    "package.json": '{"name":"t","type":"module"}',
  });

  // Capture baseline: one failure pre-existing.
  const baseline = captureTestBaseline(dir);
  expect(baseline.hadAnyTests).toBe(true);
  expect(baseline.failingIds.has("pre-existing fail")).toBe(true);

  // Fix the bug AND add a passing test for the new feature.
  await writeFile(
    join(dir, "src/m.ts"),
    "export const add = (a: number, b: number) => a + b;\n",
    "utf-8",
  );

  // The pre-existing test now passes too (as a side-effect of the fix), plus ≥1 pass.
  // Oracle should see 0 new failures → solved.
  const verdict = await runTieredOracle(dir, { baseline });
  expect(verdict.outcome).toBe("solved");
  expect(verdict.newFailures).toHaveLength(0);
}, 60_000);

test("baseline fix: pre-existing red, nothing solved → failing, newFailures empty", async () => {
  // Start with a failing test; capture baseline; do nothing; re-run oracle.
  const dir = await scaffold({
    "src/m.ts": "export const add = (a: number, b: number) => a - b;\n",
    "tests/red.test.ts":
      'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("add should work", () => expect(add(2, 3)).toBe(5));\n',
    "package.json": '{"name":"t","type":"module"}',
  });

  const baseline = captureTestBaseline(dir);
  // Run oracle without changing anything — same failure as baseline.
  const verdict = await runTieredOracle(dir, { baseline });
  expect(verdict.outcome).toBe("failing");
  // The failure was pre-existing, not new.
  expect(verdict.newFailures).toHaveLength(0);
}, 60_000);

test("baseline fix: pre-existing red + NEW failing test → failing, newFailures has only new id", async () => {
  const dir = await scaffold({
    "src/m.ts": "export const add = (a: number, b: number) => a - b;\n",
    "tests/pre-existing.test.ts":
      'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("pre-existing fail", () => expect(add(2, 3)).toBe(5));\n',
    "package.json": '{"name":"t","type":"module"}',
  });

  const baseline = captureTestBaseline(dir);

  // Add a NEW failing test on top.
  await writeFile(
    join(dir, "tests/new-fail.test.ts"),
    'import { test, expect } from "bun:test";\ntest("brand new failure", () => expect(1).toBe(999));\n',
    "utf-8",
  );

  const verdict = await runTieredOracle(dir, { baseline });
  expect(verdict.outcome).toBe("failing");
  expect(verdict.newFailures).toContain("brand new failure");
  expect(verdict.newFailures).not.toContain("pre-existing fail");
}, 60_000);

// ===== BACK-COMPAT: no-baseline arg behaves as before =====

test("solved: passing test → outcome solved", async () => {
  const dir = await scaffold({
    "src/m.ts": "export const add = (a: number, b: number) => a + b;\n",
    "tests/m.test.ts":
      'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("a", () => expect(add(2, 3)).toBe(5));\n',
    "package.json": '{"name":"t","type":"module"}',
  });
  const v = await runTieredOracle(dir);
  expect(v.outcome).toBe("solved");
}, 60_000);

test("failing: failing test → outcome failing with feedback", async () => {
  const dir = await scaffold({
    "src/m.ts": "export const add = (a: number, b: number) => a - b;\n",
    "tests/m.test.ts":
      'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("a", () => expect(add(2, 3)).toBe(5));\n',
    "package.json": '{"name":"t","type":"module"}',
  });
  const v = await runTieredOracle(dir);
  expect(v.outcome).toBe("failing");
  expect(v.feedback.toLowerCase()).toContain("fail");
}, 60_000);

test("clean: no test + well-typed code (+tsconfig) → outcome clean", async () => {
  const dir = await scaffold({
    "src/g.ts": "export const greet = (n: string): string => `hi ${n}`;\n",
    "tsconfig.json": TSCONFIG,
    "package.json": '{"name":"t","type":"module"}',
  });
  const v = await runTieredOracle(dir);
  expect(v.outcome).toBe("clean");
}, 60_000);

test("failing: no test + real type error (+tsconfig) → outcome failing", async () => {
  const dir = await scaffold({
    // string * number — a real TS2362/2363 type error, not a config issue.
    "src/g.ts": "export const greet = (n: string): string => n * 2;\n",
    "tsconfig.json": TSCONFIG,
    "package.json": '{"name":"t","type":"module"}',
  });
  const v = await runTieredOracle(dir);
  expect(v.outcome).toBe("failing");
  expect(v.feedback.toLowerCase()).toContain("type");
}, 60_000);

test("clean (not false-fail): no test + no tsconfig → typecheck skipped, outcome clean", async () => {
  // Bare dir: tsc can't run usefully (no inputs / config). Must degrade to
  // skipped, NOT block the task as failing.
  const dir = await scaffold({
    "src/g.ts": "export const greet = (n) => n;\n",
    "package.json": '{"name":"t","type":"module"}',
  });
  const v = await runTieredOracle(dir);
  expect(v.outcome).toBe("clean");
}, 60_000);

test("captureTestBaseline: absent-tests repo → hadAnyTests false, oracle falls through to typecheck clean", async () => {
  const dir = await scaffold({
    "src/g.ts": "export const greet = (n: string) => n;\n",
    "package.json": '{"name":"t","type":"module"}',
  });

  const baseline = captureTestBaseline(dir);
  expect(baseline.hadAnyTests).toBe(false);
  expect(baseline.failingIds.size).toBe(0);

  // Oracle with this baseline should fall through to Tier 2 (typecheck) and
  // return "clean" since there's no tsconfig to enforce strict checks.
  const verdict = await runTieredOracle(dir, { baseline });
  expect(verdict.outcome).toBe("clean");
}, 60_000);

// ===== COUNT-GUARD: unparseable (error-type) failures =====

test("count guard: agent introduces a module-error failure (no (fail) line) → failing, not solved", async () => {
  // Baseline: one passing test, repo green.
  const dir = await scaffold({
    "src/m.ts": "export const add = (a: number, b: number) => a + b;\n",
    "tests/ok.test.ts":
      'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("ok", () => expect(add(2, 3)).toBe(5));\n',
    "package.json": '{"name":"t","type":"module"}',
  });
  const baseline = captureTestBaseline(dir);
  expect(baseline.redCount).toBe(0);

  // Agent "edit": add a test file that throws at import (module-load error).
  // Bun reports this as an `error` in the summary with NO `(fail) <name>` line,
  // so the id-parser sees nothing — only the count guard catches it.
  await writeFile(
    join(dir, "tests", "crash.test.ts"),
    'import { nope } from "../src/does-not-exist.ts";\nimport { test } from "bun:test";\ntest("never", () => nope());\n',
    "utf-8",
  );

  const verdict = await runTieredOracle(dir, { baseline });
  expect(verdict.outcome).toBe("failing");
}, 60_000);

test("honesty: pre-existing crash still red → failing even if a new test passes", async () => {
  // A pre-existing crashing test (unparseable error) plus a normal passing test.
  // Honest semantics: the suite is NOT green, so the run is NOT "solved" — the
  // success tick must never show while a test is red, even an unrelated one.
  const dir = await scaffold({
    "src/m.ts": "export const add = (a: number, b: number) => a + b;\n",
    "tests/crash.test.ts":
      'import { gone } from "../src/missing.ts";\nimport { test } from "bun:test";\ntest("x", () => gone());\n',
    "package.json": '{"name":"t","type":"module"}',
  });
  const baseline = captureTestBaseline(dir);
  expect(baseline.redCount).toBeGreaterThanOrEqual(1);

  // Agent adds a passing test. Pre-existing crash unchanged → suite still red.
  await writeFile(
    join(dir, "tests", "feature.test.ts"),
    'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("feature", () => expect(add(1, 1)).toBe(2));\n',
    "utf-8",
  );

  const verdict = await runTieredOracle(dir, { baseline });
  expect(verdict.outcome).toBe("failing");
}, 60_000);
