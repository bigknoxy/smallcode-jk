#!/usr/bin/env bun
/**
 * validate-realrepo-tasks.ts — idempotent integrity guard for realrepo eval tasks.
 *
 * For EVERY task in a realrepo-style suite (one that ships a `referenceSolution`
 * overlay), this asserts three properties the normal `SMALLCODE_DRY_RUN` check
 * does NOT all cover:
 *
 *   1. BUG IS REAL    — the BASE fixture alone FAILS its grader. (dry-run never
 *                       checks this; a task whose base already passes is a no-op
 *                       that silently scores pass@1=1.0 for free.)
 *   2. FIX IS REAL    — BASE + SOLUTION overlay PASSES its grader. (same as
 *                       dry-run, repeated here so one command proves both ends.)
 *   3. TARGET IS REAL — pickTargetFunction() on the buggy `src/index.*` returns a
 *                       defined function, i.e. retrieval can aim the edit at a
 *                       real symbol rather than leaving the model to guess. Catches
 *                       a task whose bug sits where the retriever can't target it
 *                       (the mri `toVal` class of confound).
 *
 * No model is invoked — pure fixture + oracle + static analysis, so it is fast,
 * deterministic, and safe to run in CI or before committing a new task.
 *
 * Usage:
 *   bun scripts/validate-realrepo-tasks.ts            # suite "realrepo"
 *   SMALLCODE_SUITE=realrepo bun scripts/validate-realrepo-tasks.ts
 *
 * Exit 0 iff every task passes all three checks; exit 1 otherwise.
 */
import { mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSuite } from "../src/eval/task-loader.ts";
import { runDeterministicGrader } from "../src/eval/graders/deterministic.ts";
import { runStaticGrader } from "../src/eval/graders/static.ts";
import { extractSymbols } from "../src/context/extractor.ts";
import { pickTargetFunction } from "../src/context/builder.ts";
import type { GraderConfig, GraderResult } from "../src/eval/types.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SUITE_NAME = process.env.SMALLCODE_SUITE ?? "realrepo";
const SUITE_DIR = join(PROJECT_ROOT, "evals", "suites", SUITE_NAME);
const FIXTURES_DIR = join(PROJECT_ROOT, "evals", "fixtures");
const TMP_BASE = join(tmpdir(), "smallcode-validate-realrepo");

async function runGrader(grader: GraderConfig, trialDir: string): Promise<GraderResult> {
  switch (grader.type) {
    case "deterministic_tests":
      return runDeterministicGrader(grader, trialDir);
    case "static_analysis":
      return runStaticGrader(grader, trialDir);
    case "llm_rubric":
      return { type: "llm_rubric", verdict: "unknown", score: 0, output: "skipped", durationMs: 0 };
  }
}

async function layBase(trialDir: string, repoFixture: string | undefined, files: Record<string, string> | undefined) {
  await rm(trialDir, { recursive: true, force: true });
  await mkdir(trialDir, { recursive: true });
  if (repoFixture !== undefined) await cp(join(FIXTURES_DIR, repoFixture), trialDir, { recursive: true });
  if (files !== undefined) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(trialDir, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await Bun.write(abs, content);
    }
  }
}

const langOf = (path: string): string =>
  path.endsWith(".ts") || path.endsWith(".tsx") ? "typescript" : "javascript";

async function checkRetrieval(repoFixture: string, refSol: string, desc: string): Promise<string> {
  // Probe exactly the source file(s) the SOLUTION overlay edits — that is where
  // the bug lives, so a defined pick proves retrieval can aim the edit at a real
  // function in the actual buggy file (single- OR multi-file). An undefined pick
  // is the mri-`toVal` confound: the model would be left to guess the target.
  const solDir = join(FIXTURES_DIR, refSol);
  const glob = new Bun.Glob("**/*.{js,jsx,ts,tsx}");
  const picks: string[] = [];
  for await (const rel of glob.scan(solDir)) {
    if (rel.includes("test")) continue;
    const buggy = join(FIXTURES_DIR, repoFixture, rel);
    if (!(await Bun.file(buggy).exists())) continue;
    const content = await Bun.file(buggy).text();
    const syms = extractSymbols(rel, content, langOf(rel));
    const pick = pickTargetFunction(syms, content, desc);
    picks.push(`${rel.replace(/^src\//, "")}:${pick ?? "<undefined>"}`);
  }
  if (picks.length === 0) return "<no source>";
  // Pass iff every overlaid source file yields a defined target.
  return picks.some((p) => p.endsWith("<undefined>")) ? `UNDEF(${picks.join(",")})` : picks.join(",");
}

async function main() {
  const suite = await loadSuite(SUITE_DIR);
  const rows: Array<{ id: string; bugReal: boolean; fixReal: boolean; target: string; ok: boolean }> = [];

  for (const task of suite.tasks) {
    const refSol = task.referenceSolution;
    if (refSol === undefined) continue; // only solution-backed tasks are validated here
    const repoFixture = task.setup.repoFixture;
    const trialDir = join(TMP_BASE, task.id);

    // 1. BASE alone must FAIL
    await layBase(trialDir, repoFixture, task.setup.files);
    const baseResults = await Promise.all(task.graders.map((g) => runGrader(g, trialDir)));
    const bugReal = !baseResults.every((r) => r.verdict === "pass");

    // 2. BASE + SOLUTION overlay must PASS
    await cp(join(FIXTURES_DIR, refSol), trialDir, { recursive: true });
    const solResults = await Promise.all(task.graders.map((g) => runGrader(g, trialDir)));
    const fixReal = solResults.every((r) => r.verdict === "pass");

    // 3. retrieval target is a real function in every overlaid (buggy) source file
    const target = repoFixture ? await checkRetrieval(repoFixture, refSol, task.desc) : "<inline>";
    const targetOk = !target.startsWith("UNDEF") && target !== "<no source>";

    const ok = bugReal && fixReal && targetOk;
    rows.push({ id: task.id, bugReal, fixReal, target, ok });
    await rm(trialDir, { recursive: true, force: true });
  }

  const w = Math.max(...rows.map((r) => r.id.length), 4);
  console.log(`\n${"task".padEnd(w)} | bug-real | fix-real | target           | verdict`);
  console.log(`${"-".repeat(w)}-+----------+----------+------------------+--------`);
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(w)} | ${(r.bugReal ? "yes" : "NO ").padEnd(8)} | ${(r.fixReal ? "yes" : "NO ").padEnd(8)} | ${r.target.padEnd(16)} | ${r.ok ? "PASS" : "FAIL"}`,
    );
  }
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length} tasks, ${rows.length - failed.length} pass, ${failed.length} fail.`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((r) => r.id).join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[validate-realrepo] ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
