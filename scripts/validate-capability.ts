#!/usr/bin/env bun
/**
 * Capability validation script — verifies that all capability eval tasks have a
 * reference_solution fixture and that each fixture passes its graders.
 *
 * Run: bun scripts/validate-capability.ts
 *
 * Exits 0 if all reference solutions pass all graders.
 * Exits 1 if any fail.
 */

import { mkdir, cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadSuite } from "../src/eval/task-loader.ts";
import { runDeterministicGrader } from "../src/eval/graders/deterministic.ts";
import { runStaticGrader } from "../src/eval/graders/static.ts";
import type { EvalTask, GraderConfig } from "../src/eval/types.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SUITE_DIR = join(PROJECT_ROOT, "evals", "suites", "capability");
const FIXTURES_DIR = join(PROJECT_ROOT, "evals", "fixtures");
const TMP_BASE = join(PROJECT_ROOT, ".tmp-validate-capability");

async function runGrader(grader: GraderConfig, trialDir: string) {
  switch (grader.type) {
    case "deterministic_tests":
      return runDeterministicGrader(grader, trialDir);
    case "static_analysis":
      return runStaticGrader(grader, trialDir);
    case "llm_rubric":
      return {
        type: "llm_rubric" as const,
        verdict: "unknown" as const,
        score: 0,
        output: "llm_rubric grader skipped in validation",
        durationMs: 0,
      };
  }
}

async function validateTask(
  task: EvalTask,
): Promise<{ taskId: string; passed: boolean; reason?: string }> {
  const { id: taskId, referenceSolution } = task;

  if (!referenceSolution) {
    return { taskId, passed: false, reason: "no referenceSolution field" };
  }

  const fixtureDir = join(FIXTURES_DIR, referenceSolution);
  const trialDir = join(TMP_BASE, taskId);

  try {
    // Clean up any previous run
    await rm(trialDir, { recursive: true, force: true });
    await mkdir(trialDir, { recursive: true });

    // Copy fixture to tmp dir
    await cp(fixtureDir, trialDir, { recursive: true });

    // Run each grader
    const graderResults = await Promise.all(
      task.graders.map((grader) => runGrader(grader, trialDir)),
    );

    const allPassed = graderResults.every((r) => r.verdict === "pass");

    if (!allPassed) {
      const failures = graderResults
        .filter((r) => r.verdict !== "pass")
        .map((r) => `${r.type}=${r.verdict}: ${r.output.slice(0, 300)}`)
        .join("; ");
      return { taskId, passed: false, reason: failures };
    }

    return { taskId, passed: true };
  } catch (err) {
    return {
      taskId,
      passed: false,
      reason: `exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // Clean up tmp dir
    await rm(trialDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("[validate-capability] Loading capability suite...");

  const suite = await loadSuite(SUITE_DIR);
  console.log(`[validate-capability] Found ${suite.tasks.length} tasks\n`);

  // Ensure tmp base dir exists
  await mkdir(TMP_BASE, { recursive: true });

  let passCount = 0;
  let failCount = 0;

  // Run sequentially to avoid tmp dir collisions and noisy output
  for (const task of suite.tasks) {
    const result = await validateTask(task);
    if (result.passed) {
      passCount++;
      console.log(`  PASS  ${result.taskId}`);
    } else {
      failCount++;
      console.log(`  FAIL  ${result.taskId}`);
      if (result.reason) {
        console.log(`        reason: ${result.reason}`);
      }
    }
  }

  // Clean up tmp base dir
  await rm(TMP_BASE, { recursive: true, force: true });

  console.log(`\n[validate-capability] Results: ${passCount} pass, ${failCount} fail`);

  if (failCount > 0) {
    process.exit(1);
  }

  console.log("[validate-capability] All reference solutions pass.");
}

main().catch((err: unknown) => {
  console.error(
    "[validate-capability] ERROR:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
