#!/usr/bin/env bun
/**
 * GEPA smoke script — created, NOT run.
 *
 * Wires the GEPA engine against E0–E2 eval tasks with:
 *   K=1 trial per task, populationCap=5, maxGenerations=3
 *
 * This script is intentionally guarded with `if (import.meta.main)` so that
 * importing it from tests does NOT trigger execution.
 *
 * To run manually (requires SMALLCODE_* env vars + running Ollama):
 *   bun scripts/gepa-smoke.ts
 */

import { join, resolve } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { defaultPromptSet } from "../src/agent/prompt-set.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import { loadSuite } from "../src/eval/task-loader.ts";
import { runTask } from "../src/eval/task-runner.ts";
import type { EvalTask, TaskEvalResult } from "../src/eval/types.ts";
import type { TaskRunnerOptions } from "../src/eval/task-runner.ts";
import { MockMutator } from "../src/improve/gepa/mutator.ts";
import { runGepa } from "../src/improve/gepa/engine.ts";
import type { Candidate } from "../src/improve/gepa/types.ts";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SUITE_DIR = join(PROJECT_ROOT, "evals", "suites", "capability");
const FIXTURES_DIR = join(PROJECT_ROOT, "evals", "fixtures");

// ---------------------------------------------------------------------------
// Guard: only run when executed directly (not imported by tests)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  console.log("[gepa-smoke] Loading capability suite...");

  const { config, extraModels } = loadConfig();
  for (const m of extraModels) defaultRegistry.register(m);

  const profile = defaultRegistry.get(config.activeModel);
  const provider = createProvider(config.provider, defaultRegistry);
  const reasoningHandler = new ReasoningHandler(
    profile.reasoningTags ?? { open: "<think>", close: "</think>" },
  );

  // Load the full suite and select the first 3 tasks (E0–E2 subset)
  const suite = await loadSuite(SUITE_DIR);
  const targetTasks: EvalTask[] = suite.tasks.slice(0, 3);
  const taskIds = targetTasks.map((t) => t.id);

  console.log(`[gepa-smoke] Tasks: ${taskIds.join(", ")}`);

  // Base agent config (repoRoot overridden per trial inside runTask)
  const baseAgentConfig = {
    repoRoot: PROJECT_ROOT,
    modelId: profile.id,
    maxTurns: 5,
    bestOfN: 1,
    allowedCommands: config.sandbox.allowedCommands,
    requireApproval: false,
    disciplineRules: true,
    preSolveReflection: false,
  };

  const loopDeps = {
    provider,
    profile,
    reasoningHandler,
    config: baseAgentConfig,
  };

  // Seed candidate (generation 0) uses the default prompt set
  const seedPrompts = defaultPromptSet({ disciplineRules: true });
  const seedScores: Record<string, number> = {};
  for (const tid of taskIds) seedScores[tid] = 0;

  const seed: Candidate = {
    id: randomUUID(),
    prompts: seedPrompts,
    parentId: null,
    generation: 0,
    scores: seedScores,
    meanScore: 0,
  };

  // Use MockMutator as a placeholder — swap for a live LLM mutator when ready
  const mutator = new MockMutator();

  // Injectable runTask (real eval runner)
  const runTaskFn = (task: EvalTask, opts: TaskRunnerOptions): Promise<TaskEvalResult> =>
    runTask(task, opts);

  const evalDeps = {
    baseAgentConfig,
    loopDeps,
    tasks: targetTasks,
    fixturesRoot: FIXTURES_DIR,
    runTaskFn,
  };

  const gepaCfg = {
    taskIds,
    populationCap: 5,
    maxGenerations: 3,
    trialsPerTask: 1,
  };

  console.log("[gepa-smoke] Running GEPA (3 generations, K=1, populationCap=5)...");
  const frontMembers = await runGepa(seed, mutator, evalDeps, gepaCfg);

  console.log(`[gepa-smoke] Final Pareto front: ${frontMembers.length} member(s)`);
  for (const m of frontMembers) {
    const scoreStr = taskIds.map((tid) => `${tid}=${(m.scores[tid] ?? 0).toFixed(2)}`).join(", ");
    console.log(`  gen=${m.generation} meanScore=${m.meanScore.toFixed(3)} [${scoreStr}]`);
  }

  const best = frontMembers.reduce(
    (best, m) => (m.meanScore > best.meanScore ? m : best),
    frontMembers[0] as Candidate,
  );
  console.log(`[gepa-smoke] Best candidate: id=${best.id} meanScore=${best.meanScore.toFixed(3)}`);
  console.log("[gepa-smoke] Done.");
}
