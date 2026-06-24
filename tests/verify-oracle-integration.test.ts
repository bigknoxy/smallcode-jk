import { test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTieredOracle } from "../src/verify/oracle.ts";

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
  compilerOptions: { strict: true, noEmit: true, module: "esnext", target: "esnext", moduleResolution: "bundler" },
  include: ["src"],
});

test("solved: passing test → outcome solved", async () => {
  const dir = await scaffold({
    "src/m.ts": "export const add = (a: number, b: number) => a + b;\n",
    "tests/m.test.ts":
      'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("a", () => expect(add(2, 3)).toBe(5));\n',
    "package.json": '{"name":"t","type":"module"}',
  });
  const v = await runTieredOracle(dir);
  expect(v.outcome).toBe("solved");
}, 30_000);

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
}, 30_000);

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
