#!/usr/bin/env bun
/**
 * Baseline runner for the capability eval suite.
 *
 * Dry-run mode (SMALLCODE_DRY_RUN=1):
 *   Verifies all tasks have reference solutions and all graders pass against fixtures.
 *   Exits 0 if all pass, 1 if any fail.
 *
 * Live mode (default):
 *   Runs the full agent harness at k=5 trials per task and records metrics.
 *   Requires SMALLCODE_* env vars for model/provider config.
 *
 * Usage:
 *   SMALLCODE_DRY_RUN=1 bun scripts/run-baseline.ts
 *   bun scripts/run-baseline.ts
 */

import { mkdir, cp, rm, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { runTask } from "../src/eval/task-runner.ts";
import { loadSuite } from "../src/eval/task-loader.ts";
import { runDeterministicGrader } from "../src/eval/graders/deterministic.ts";
import { runStaticGrader } from "../src/eval/graders/static.ts";
import type { EvalTask, GraderConfig, GraderResult, TaskEvalResult } from "../src/eval/types.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import type { MetricsSnapshot } from "../src/improve/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SUITE_DIR = join(PROJECT_ROOT, "evals", "suites", "capability");
const FIXTURES_DIR = join(PROJECT_ROOT, "evals", "fixtures");
const METRICS_HISTORY_PATH = join(PROJECT_ROOT, "evals", "metrics-history.jsonl");
const TMP_BASE = join(PROJECT_ROOT, ".tmp-baseline");

const DRY_RUN = process.env.SMALLCODE_DRY_RUN === "1";
// Eval-specific overrides: fewer turns + trials to keep total wall-clock under ~30 min.
// Production config has maxTurns=15; eval only needs enough to attempt + verify a fix.
const EVAL_MAX_TURNS = Number(process.env.SMALLCODE_EVAL_MAX_TURNS ?? "6");
const EVAL_K = Number(process.env.SMALLCODE_EVAL_K ?? "3");

// ---------------------------------------------------------------------------
// Grader dispatch (same as validate-e1)
// ---------------------------------------------------------------------------

async function runGrader(grader: GraderConfig, trialDir: string): Promise<GraderResult> {
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
        output: "llm_rubric grader skipped in baseline runner",
        durationMs: 0,
      };
  }
}

// ---------------------------------------------------------------------------
// Dry-run: validate reference solution against graders
// ---------------------------------------------------------------------------

interface DryRunResult {
  taskId: string;
  passed: boolean;
  reason?: string;
  durationMs: number;
}

async function dryRunTask(task: EvalTask): Promise<DryRunResult> {
  const { id: taskId, referenceSolution } = task;
  const startMs = Date.now();

  if (!referenceSolution) {
    return { taskId, passed: false, reason: "no referenceSolution field", durationMs: 0 };
  }

  const fixtureDir = join(FIXTURES_DIR, referenceSolution);
  const trialDir = join(TMP_BASE, taskId);

  try {
    await rm(trialDir, { recursive: true, force: true });
    await mkdir(trialDir, { recursive: true });
    await cp(fixtureDir, trialDir, { recursive: true });

    const graderResults = await Promise.all(
      task.graders.map((grader) => runGrader(grader, trialDir)),
    );

    const allPassed = graderResults.every((r) => r.verdict === "pass");
    if (!allPassed) {
      const failures = graderResults
        .filter((r) => r.verdict !== "pass")
        .map((r) => `${r.type}=${r.verdict}: ${r.output.slice(0, 200)}`)
        .join("; ");
      return { taskId, passed: false, reason: failures, durationMs: Date.now() - startMs };
    }

    return { taskId, passed: true, durationMs: Date.now() - startMs };
  } catch (err) {
    return {
      taskId,
      passed: false,
      reason: `exception: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startMs,
    };
  } finally {
    await rm(trialDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Summary table helpers
// ---------------------------------------------------------------------------

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padStart(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function printDryRunTable(results: DryRunResult[]): void {
  const COL1 = 32;
  const COL2 = 8;
  const COL3 = 10;

  const sep = `${"-".repeat(COL1)}-+-${"-".repeat(COL2)}-+-${"-".repeat(COL3)}`;
  console.log(`\n${padEnd("task-id", COL1)} | ${padEnd("result", COL2)} | ${"duration"}`);
  console.log(sep);
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log(
      `${padEnd(r.taskId, COL1)} | ${padEnd(status, COL2)} | ${padStart(`${r.durationMs}ms`, COL3)}`,
    );
    if (!r.passed && r.reason) {
      console.log(`  reason: ${r.reason}`);
    }
  }
  console.log(sep);
}

// ---------------------------------------------------------------------------
// Live-run stubs (not exercised in dry-run)
// ---------------------------------------------------------------------------

interface LiveTaskMetrics {
  taskId: string;
  passAt1: number;
  passAtK: number;
  avgTurns: number;
  avgTokens: number;
}

async function liveRunTask(task: EvalTask, k: number): Promise<LiveTaskMetrics> {
  const { config, extraModels } = loadConfig();
  for (const m of extraModels) defaultRegistry.register(m);

  const profile = defaultRegistry.get(config.activeModel);
  const provider = createProvider(config.provider, defaultRegistry);
  const reasoningHandler = new ReasoningHandler(
    profile.reasoningTags ?? { open: "<think>", close: "</think>" },
  );

  const agentConfig = {
    repoRoot: PROJECT_ROOT, // overridden per trial inside runTask
    modelId: profile.id,
    maxTurns: EVAL_MAX_TURNS,
    bestOfN: 1, // best-of-N inside eval adds noise; use k trials instead
    allowedCommands: config.sandbox.allowedCommands,
    requireApproval: false,
  };

  const loopDeps = {
    provider,
    profile,
    reasoningHandler,
    config: agentConfig,
  };

  const result: TaskEvalResult = await runTask(task, {
    trialsPerTask: k,
    fixturesRoot: FIXTURES_DIR,
    agentConfig,
    loopDeps,
  });

  const avgTurns =
    result.trials.length === 0
      ? 0
      : result.trials.reduce((sum, t) => sum + t.metrics.nTurns, 0) / result.trials.length;

  const avgTokens =
    result.trials.length === 0
      ? 0
      : result.trials.reduce((sum, t) => sum + t.metrics.nTotalTokens, 0) / result.trials.length;

  return {
    taskId: task.id,
    passAt1: result.passAt1,
    passAtK: result.passAtK[k] ?? result.passAt1,
    avgTurns,
    avgTokens,
  };
}

function printLiveTable(metrics: LiveTaskMetrics[]): void {
  const COL1 = 32;
  const COL2 = 8;
  const COL3 = 8;
  const COL4 = 10;
  const COL5 = 12;
  const sep = `${"-".repeat(COL1)}-+-${"-".repeat(COL2)}-+-${"-".repeat(COL3)}-+-${"-".repeat(COL4)}-+-${"-".repeat(COL5)}`;
  console.log(
    `\n${padEnd("task-id", COL1)} | ${padEnd("pass@1", COL2)} | ${padEnd("pass^k", COL3)} | ${padEnd("avg_turns", COL4)} | ${"avg_tokens"}`,
  );
  console.log(sep);
  for (const m of metrics) {
    console.log(
      `${padEnd(m.taskId, COL1)} | ${padEnd(m.passAt1.toFixed(2), COL2)} | ${padEnd(m.passAtK.toFixed(2), COL3)} | ${padEnd(m.avgTurns.toFixed(1), COL4)} | ${m.avgTokens.toFixed(0)}`,
    );
  }
  console.log(sep);
}

// ---------------------------------------------------------------------------
// MetricsSnapshot writer
// ---------------------------------------------------------------------------

async function appendMetricsSnapshot(snapshot: MetricsSnapshot): Promise<void> {
  const line = JSON.stringify(snapshot) + "\n";
  await appendFile(METRICS_HISTORY_PATH, line, "utf-8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = DRY_RUN ? "DRY RUN" : "LIVE";
  console.log(`[run-baseline] Mode: ${mode}`);
  console.log(`[run-baseline] Loading capability suite from ${SUITE_DIR}...`);

  const suite = await loadSuite(SUITE_DIR);
  console.log(`[run-baseline] Found ${suite.tasks.length} tasks in suite "${suite.id}"\n`);

  await mkdir(TMP_BASE, { recursive: true });

  if (DRY_RUN) {
    // -----------------------------------------------------------------------
    // Dry-run: validate all reference solutions through their graders
    // -----------------------------------------------------------------------
    let passCount = 0;
    let failCount = 0;
    const results: DryRunResult[] = [];

    for (const task of suite.tasks) {
      process.stdout.write(`  Running ${task.id}...`);
      const result = await dryRunTask(task);
      results.push(result);
      if (result.passed) {
        passCount++;
        process.stdout.write(" PASS\n");
      } else {
        failCount++;
        process.stdout.write(" FAIL\n");
        if (result.reason) {
          console.log(`    reason: ${result.reason}`);
        }
      }
    }

    printDryRunTable(results);

    // Write a synthetic MetricsSnapshot so metrics-history.jsonl is populated
    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      runId: `dry-run-${Date.now()}`,
      suiteId: suite.id,
      modelId: "reference-solutions",
      overallPassAt1: passCount / suite.tasks.length,
      totalTasksPassed: passCount,
      totalTasks: suite.tasks.length,
      perTaskPassAt1: Object.fromEntries(results.map((r) => [r.taskId, r.passed ? 1 : 0])),
    };
    await appendMetricsSnapshot(snapshot);

    await rm(TMP_BASE, { recursive: true, force: true });

    console.log(`\n[run-baseline] Results: ${passCount} pass, ${failCount} fail`);
    console.log(`[run-baseline] Metrics appended to ${METRICS_HISTORY_PATH}`);

    if (failCount > 0) {
      process.exit(1);
    }

    console.log("[run-baseline] All reference solutions pass.");
  } else {
    // -----------------------------------------------------------------------
    // Live run: EVAL_K trials per task (default 3; override with SMALLCODE_EVAL_K)
    // -----------------------------------------------------------------------
    const K = EVAL_K;
    const allMetrics: LiveTaskMetrics[] = [];
    let passCount = 0;

    const total = suite.tasks.length;
    for (let i = 0; i < suite.tasks.length; i++) {
      const task = suite.tasks[i];
      if (!task) continue;
      console.log(`  [${i + 1}/${total}] ${task.id}...`);
      try {
        const t0 = Date.now();
        const m = await liveRunTask(task, K);
        const elapsed = Math.round((Date.now() - t0) / 1000);
        allMetrics.push(m);
        if (m.passAt1 > 0) passCount++;
        console.log(`        pass@1=${m.passAt1.toFixed(2)} turns=${m.avgTurns.toFixed(1)} (${elapsed}s)`);
      } catch (err) {
        console.error(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    printLiveTable(allMetrics);

    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      runId: `live-${Date.now()}`,
      suiteId: suite.id,
      modelId: loadConfig().config.activeModel,
      overallPassAt1: allMetrics.reduce((sum, m) => sum + m.passAt1, 0) / allMetrics.length,
      totalTasksPassed: passCount,
      totalTasks: suite.tasks.length,
      perTaskPassAt1: Object.fromEntries(allMetrics.map((m) => [m.taskId, m.passAt1])),
    };
    await appendMetricsSnapshot(snapshot);

    await rm(TMP_BASE, { recursive: true, force: true });

    console.log(`\n[run-baseline] Results: ${passCount}/${suite.tasks.length} tasks with pass@1 > 0`);
    console.log(`[run-baseline] Metrics appended to ${METRICS_HISTORY_PATH}`);
  }
}

main().catch((err: unknown) => {
  console.error("[run-baseline] ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
