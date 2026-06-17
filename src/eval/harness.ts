import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopDependencies } from "../agent/loop.ts";
import type { AgentConfig } from "../agent/types.ts";
import type { LLMJudgeOptions } from "./graders/index.ts";
import { runTask } from "./task-runner.ts";
import type { EvalRunResult, EvalSuite } from "./types.ts";

export interface HarnessOptions {
  trialsPerTask?: number; // override suite.defaultTrials
  fixturesRoot: string;
  transcriptsDir: string;
  agentConfig: AgentConfig;
  loopDeps: LoopDependencies;
  graderOpts?: LLMJudgeOptions;
  concurrency?: number; // max parallel tasks (default: 1 — sequential)
}

export async function runSuite(suite: EvalSuite, opts: HarnessOptions): Promise<EvalRunResult> {
  const runId = randomUUID();
  const startedAt = Date.now();

  const trialsPerTask = opts.trialsPerTask ?? suite.defaultTrials;
  // concurrency option reserved for future parallel execution; currently sequential
  void (opts.concurrency ?? 1);

  const taskResults = [];

  // Sequential execution (concurrency=1 is default — eval accuracy > speed)
  for (const task of suite.tasks) {
    const result = await runTask(task, {
      trialsPerTask,
      fixturesRoot: opts.fixturesRoot,
      agentConfig: opts.agentConfig,
      loopDeps: opts.loopDeps,
      graderOpts: opts.graderOpts,
    });
    taskResults.push(result);
  }

  const finishedAt = Date.now();

  const totalTrials = taskResults.reduce((sum, r) => sum + r.trials.length, 0);
  const totalTasksPassed = taskResults.filter((r) => r.passAt1 >= 1.0).length;
  const overallPassAt1 =
    taskResults.length === 0
      ? 0
      : taskResults.reduce((sum, r) => sum + r.passAt1, 0) / taskResults.length;

  const runResult: EvalRunResult = {
    runId,
    suiteId: suite.id,
    modelId: opts.agentConfig.modelId,
    taskResults,
    overallPassAt1,
    totalTrials,
    totalTasksPassed,
    startedAt,
    finishedAt,
  };

  // Save result to transcriptsDir/<runId>.json
  await mkdir(opts.transcriptsDir, { recursive: true });
  const outPath = join(opts.transcriptsDir, `${runId}.json`);
  await writeFile(outPath, JSON.stringify(runResult, null, 2), { encoding: "utf-8", mode: 0o600 });

  return runResult;
}
