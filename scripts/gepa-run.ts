#!/usr/bin/env bun
/**
 * GEPA live runner.
 *
 * Evolves the agent's system prompt against the edit-reliability suite (TRAIN
 * set) using the LIVE reflective mutator (a strong reflection model rewrites the
 * system prompt from failed-task transcripts), scores each candidate on the full
 * suite, and keeps a Pareto front. Prints the final front and writes the best
 * candidate's PromptSet to evals/gepa-best.json for held-out validation.
 *
 * Dry-run mode (SMALLCODE_GEPA_DRY_RUN=1):
 *   No GPU, no LLM, no network. Uses MockMutator + a stubbed runTask that returns
 *   deterministic synthetic scores, so the whole engine wiring is exercised and
 *   exits 0. Use for CI/smoke.
 *
 * Live mode (default — do NOT run casually; owns the single-slot GPU):
 *   Requires a running provider for BOTH the executor model (SMALLCODE_MODEL /
 *   config.activeModel) and the reflection model (SMALLCODE_GEPA_REFLECT_MODEL).
 *
 * Env contract:
 *   SMALLCODE_GEPA_DRY_RUN=1        -> dry-run (no GPU/LLM)
 *   SMALLCODE_GEPA_REFLECT_MODEL    -> (live, REQUIRED) strong reflection model id
 *   SMALLCODE_GEPA_REFLECT_BASE_URL -> (live, optional) reflection provider base url
 *   SMALLCODE_GEPA_REFLECT_API_KEY  -> (live, optional) reflection provider api key
 *   SMALLCODE_GEPA_REFLECT_MAX_TOKENS -> (live, optional) reflection sampling cap
 *   SMALLCODE_GEPA_MUTATE_PLANNER=1 -> (optional) also rewrite the planner prompt
 *   SMALLCODE_GEPA_GENERATIONS      -> generations (default 3)
 *   SMALLCODE_GEPA_TRIALS           -> trials per task when scoring (default 5)
 *   SMALLCODE_GEPA_POP_CAP          -> Pareto front cap (default 6)
 *   SMALLCODE_SUITE                 -> train suite (default edit-reliability)
 *   SMALLCODE_MODEL                 -> executor model id override
 *   SMALLCODE_EVAL_MAX_TURNS        -> executor turns per trial (default 5)
 *
 * Usage:
 *   SMALLCODE_GEPA_DRY_RUN=1 bun scripts/gepa-run.ts
 *   SMALLCODE_GEPA_REFLECT_MODEL=<strong-model> bun scripts/gepa-run.ts
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultPromptSet } from "../src/agent/prompt-set.ts";
import { loadConfig } from "../src/config/loader.ts";
import { loadSuite } from "../src/eval/task-loader.ts";
import { runTask } from "../src/eval/task-runner.ts";
import type { EvalTask, TaskEvalResult, Transcript, TrialResult } from "../src/eval/types.ts";
import type { TaskRunnerOptions } from "../src/eval/task-runner.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import { runGepa } from "../src/improve/gepa/engine.ts";
import { MockMutator } from "../src/improve/gepa/mutator.ts";
import {
  LLMReflectiveMutator,
  makeProviderComplete,
  reflectConfigFromEnv,
} from "../src/improve/gepa/reflective-mutator.ts";
import type { Candidate, GepaConfig } from "../src/improve/gepa/types.ts";
import type { ReflectiveMutator } from "../src/improve/gepa/mutator.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SUITE_NAME = process.env.SMALLCODE_SUITE ?? "edit-reliability";
const SUITE_DIR = SUITE_NAME.includes("/")
  ? resolve(PROJECT_ROOT, SUITE_NAME)
  : join(PROJECT_ROOT, "evals", "suites", SUITE_NAME);
const FIXTURES_DIR = join(PROJECT_ROOT, "evals", "fixtures");
const BEST_OUT = join(PROJECT_ROOT, "evals", "gepa-best.json");

const DRY_RUN = process.env.SMALLCODE_GEPA_DRY_RUN === "1";
const GENERATIONS = Number(process.env.SMALLCODE_GEPA_GENERATIONS ?? "3");
const TRIALS = Number(process.env.SMALLCODE_GEPA_TRIALS ?? "5");
const POP_CAP = Number(process.env.SMALLCODE_GEPA_POP_CAP ?? "6");
const EVAL_MAX_TURNS = Number(process.env.SMALLCODE_EVAL_MAX_TURNS ?? "5");

if (import.meta.main) {
  await main();
}

// ---------------------------------------------------------------------------
// Dry-run stub: deterministic synthetic scores, no GPU/LLM/network.
// ---------------------------------------------------------------------------

function makeStubRunTask(): (
  task: EvalTask,
  opts: TaskRunnerOptions,
) => Promise<TaskEvalResult> {
  return async (task: EvalTask, opts: TaskRunnerOptions): Promise<TaskEvalResult> => {
    const k = opts.trialsPerTask;
    // Deterministic-but-varied: hash the id so SOME tasks pass and some fail,
    // exercising both the mutator (failed) and the scoring (passed) paths.
    let h = 0;
    for (const ch of task.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const passAt1 = h % 3 === 0 ? 1 : 0;
    const transcript: Transcript = {
      id: randomUUID(),
      sessionId: randomUUID(),
      taskId: task.id,
      trialIndex: 0,
      modelId: "stub",
      turns: [
        {
          turn: 0,
          goalId: "g0",
          prompt: "(stub)",
          rawResponse: passAt1 ? "FILE: ok" : "(stub: model emitted prose, no edit block)",
          answer: "",
          toolCalls: [],
          toolResults: [],
          editBlocks: [],
          applyResults: [],
          promptTokens: 0,
          completionTokens: 0,
          timestamp: Date.now(),
        },
      ],
      outcome: passAt1 ? "passed" : "failed",
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };
    const trials: TrialResult[] = Array.from({ length: k }, (_, i) => ({
      taskId: task.id,
      trialIndex: i,
      passed: passAt1 === 1,
      partialScore: passAt1,
      graderResults: [],
      transcript: { ...transcript, trialIndex: i },
      metrics: {
        nTurns: 1,
        nToolCalls: 0,
        nTotalTokens: 0,
        nPromptTokens: 0,
        nCompletionTokens: 0,
        latencyMs: 0,
      },
    }));
    return {
      task,
      trials,
      passAt1,
      passAtK: { 1: passAt1 },
      passAllK: passAt1,
      avgPartialScore: passAt1,
      avgMetrics: {
        nTurns: 1,
        nToolCalls: 0,
        nTotalTokens: 0,
        nPromptTokens: 0,
        nCompletionTokens: 0,
        latencyMs: 0,
      },
      n: k,
    };
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = DRY_RUN ? "DRY RUN" : "LIVE";
  console.log(`[gepa-run] mode=${mode} suite=${SUITE_NAME}`);

  const suite = await loadSuite(SUITE_DIR);
  const tasks: EvalTask[] = suite.tasks;
  const taskIds = tasks.map((t) => t.id);
  console.log(`[gepa-run] train tasks (${taskIds.length}): ${taskIds.join(", ")}`);

  const gepaCfg: GepaConfig = {
    taskIds,
    populationCap: POP_CAP,
    maxGenerations: GENERATIONS,
    trialsPerTask: TRIALS,
  };
  console.log(
    `[gepa-run] budget: generations=${GENERATIONS} trials=${TRIALS} populationCap=${POP_CAP}`,
  );

  // -----------------------------------------------------------------------
  // Seed candidate (default prompt set, generation 0)
  // -----------------------------------------------------------------------
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

  let mutator: ReflectiveMutator;
  let runTaskFn: (task: EvalTask, opts: TaskRunnerOptions) => Promise<TaskEvalResult>;
  // Minimal deps required to build a loop config; the stub path never uses these.
  let baseAgentConfig: import("../src/agent/types.ts").AgentConfig;
  let loopDeps: import("../src/agent/loop.ts").LoopDependencies;

  if (DRY_RUN) {
    // No GPU / no LLM: MockMutator + stubbed runTask.
    mutator = new MockMutator();
    runTaskFn = makeStubRunTask();
    baseAgentConfig = {
      repoRoot: PROJECT_ROOT,
      modelId: "stub",
      maxTurns: EVAL_MAX_TURNS,
      bestOfN: 1,
      requireApproval: false,
    };
    // loopDeps is never exercised by the stub runTaskFn, but the engine type
    // requires it; provide a typed placeholder that is never called.
    loopDeps = {
      provider: {
        complete: async () => {
          throw new Error("dry-run provider must not be called");
        },
        stream: async function* () {
          throw new Error("dry-run provider must not be called");
        },
      },
      profile: defaultRegistry.get("vibethinker-3b"),
      reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
      config: baseAgentConfig,
    };
  } else {
    // Live: real executor provider + live reflective mutator.
    const { config, extraModels } = loadConfig();
    for (const m of extraModels) defaultRegistry.register(m);

    const activeModel = process.env.SMALLCODE_MODEL || config.activeModel;
    const profile = defaultRegistry.get(activeModel);
    const provider = createProvider(config.provider, defaultRegistry);
    const reasoningHandler = new ReasoningHandler(
      profile.reasoningTags ?? { open: "<think>", close: "</think>" },
    );

    baseAgentConfig = {
      repoRoot: PROJECT_ROOT,
      modelId: profile.id,
      maxTurns: EVAL_MAX_TURNS,
      bestOfN: 1,
      allowedCommands: config.sandbox.allowedCommands,
      requireApproval: false,
      disciplineRules: true,
      preSolveReflection: false,
    };
    loopDeps = { provider, profile, reasoningHandler, config: baseAgentConfig };

    // Reflection model — strong, configured entirely via env.
    const reflectCfg = reflectConfigFromEnv(config.provider, defaultRegistry);
    const complete = makeProviderComplete(reflectCfg);
    mutator = new LLMReflectiveMutator({
      complete,
      mutatePlanner: process.env.SMALLCODE_GEPA_MUTATE_PLANNER === "1",
    });
    console.log(
      `[gepa-run] executor=${profile.id} reflector=${reflectCfg.modelId} ` +
        `mutatePlanner=${process.env.SMALLCODE_GEPA_MUTATE_PLANNER === "1"}`,
    );
    runTaskFn = (task, opts) => runTask(task, opts);
  }

  const evalDeps = {
    baseAgentConfig,
    loopDeps,
    tasks,
    fixturesRoot: FIXTURES_DIR,
    runTaskFn,
  };

  console.log("[gepa-run] running GEPA…");
  const front = await runGepa(seed, mutator, evalDeps, gepaCfg);

  // -----------------------------------------------------------------------
  // Report final Pareto front
  // -----------------------------------------------------------------------
  console.log(`\n[gepa-run] Final Pareto front: ${front.length} member(s)`);
  for (const m of front) {
    const scoreStr = taskIds
      .map((tid) => `${tid}=${(m.scores[tid] ?? 0).toFixed(2)}`)
      .join(", ");
    console.log(`  gen=${m.generation} meanScore=${m.meanScore.toFixed(3)} [${scoreStr}]`);
  }

  const best = front.reduce(
    (b, m) => (m.meanScore > b.meanScore ? m : b),
    front[0] as Candidate,
  );
  console.log(
    `\n[gepa-run] Best candidate: id=${best.id} gen=${best.generation} ` +
      `meanScore=${best.meanScore.toFixed(3)}`,
  );

  // Persist the best PromptSet for held-out validation.
  await mkdir(join(PROJECT_ROOT, "evals"), { recursive: true });
  await Bun.write(
    BEST_OUT,
    JSON.stringify(
      {
        candidateId: best.id,
        generation: best.generation,
        meanScore: best.meanScore,
        scores: best.scores,
        prompts: best.prompts,
        trainSuite: SUITE_NAME,
        mode,
      },
      null,
      2,
    ),
  );
  console.log(`[gepa-run] wrote best PromptSet -> ${BEST_OUT}`);
  console.log("[gepa-run] done.");
}
