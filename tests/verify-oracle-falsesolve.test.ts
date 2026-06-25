import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTestBaseline, runTieredOracle } from "../src/verify/oracle.ts";

// Regression for the false-solve hole found in the 2026-06-24 edit-reliability
// smoke: a task that targets a PRE-EXISTING failing test was reported "solved"
// when the edit never landed — the target stayed red, other tests passed, no
// NEW failure appeared, and the old rule called that solved.

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function scaffold(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oracle-fs-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return dir;
}

// A module with one passing-able fn and one buggy fn under test.
function statsModule(medianFixed: boolean): string {
  const medianBody = medianFixed
    ? "const s = xs.slice().sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;"
    : "return xs[Math.floor(xs.length/2)];"; // buggy: unsorted, no even handling
  return `export function mean(xs){ return xs.reduce((a,b)=>a+b,0)/xs.length; }\nexport function median(xs){ ${medianBody} }\n`;
}

const STATS_TEST =
  'import { test, expect } from "bun:test";\n' +
  'import { mean, median } from "../src/stats.ts";\n' +
  'test("mean", () => expect(mean([1,2,3,4])).toBe(2.5));\n' +
  'test("median even", () => expect(median([4,1,3,2])).toBe(2.5));\n';

test("false-solve guard: target baseline failure stays red → failing, NOT solved", async () => {
  const dir = await scaffold({
    "src/stats.ts": statsModule(false),
    "tests/stats.test.ts": STATS_TEST,
    "package.json": '{"name":"t","type":"module"}',
  });
  const baseline = captureTestBaseline(dir);
  expect(baseline.failingIds.has("median even")).toBe(true);

  // Simulate the smoke: the edit lands in the WRONG file — real stats.ts unchanged.
  await writeFile(join(dir, "src.stats.ts"), statsModule(true), "utf-8");

  const verdict = await runTieredOracle(dir, { baseline });
  expect(verdict.outcome).toBe("failing");
  expect(verdict.feedback).toContain("STILL failing");
});

test("solved when the baseline failure is actually fixed", async () => {
  const dir = await scaffold({
    "src/stats.ts": statsModule(false),
    "tests/stats.test.ts": STATS_TEST,
    "package.json": '{"name":"t","type":"module"}',
  });
  const baseline = captureTestBaseline(dir);
  expect(baseline.failingIds.has("median even")).toBe(true);

  // Edit the RIGHT file this time.
  await writeFile(join(dir, "src/stats.ts"), statsModule(true), "utf-8");

  const verdict = await runTieredOracle(dir, { baseline });
  expect(verdict.outcome).toBe("solved");
});

test("partial progress is NOT solved — one baseline failure fixed, another still red", async () => {
  // Two failing tests at baseline; fixing only one leaves the suite red. The
  // honest verdict is "failing" so the loop keeps working instead of flashing a
  // false success tick while a test is still red (the exact bug the re-smoke hit:
  // median even fixed, median odd still failing → reported verified).
  const dir = await scaffold({
    "src/a.ts": "export const f = () => 1;\n",
    "src/b.ts": "export const g = () => 0;\n",
    "tests/a.test.ts":
      'import { test, expect } from "bun:test";\nimport { f } from "../src/a.ts";\ntest("a", () => expect(f()).toBe(2));\n',
    "tests/b.test.ts":
      'import { test, expect } from "bun:test";\nimport { g } from "../src/b.ts";\ntest("b", () => expect(g()).toBe(1));\n',
    "package.json": '{"name":"t","type":"module"}',
  });
  const baseline = captureTestBaseline(dir);
  expect(baseline.failingIds.has("a")).toBe(true);
  expect(baseline.failingIds.has("b")).toBe(true);

  // Fix only test 'a'; 'b' stays red.
  await writeFile(join(dir, "src/a.ts"), "export const f = () => 2;\n", "utf-8");

  const verdict = await runTieredOracle(dir, { baseline });
  expect(verdict.outcome).toBe("failing");

  // ...and once 'b' is fixed too, the now-green suite is solved.
  await writeFile(join(dir, "src/b.ts"), "export const g = () => 1;\n", "utf-8");
  const verdict2 = await runTieredOracle(dir, { baseline });
  expect(verdict2.outcome).toBe("solved");
});
