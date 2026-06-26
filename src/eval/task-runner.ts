import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LoopDependencies } from "../agent/loop.ts";
import { runLoop } from "../agent/loop.ts";
import { createState, getStatePath } from "../agent/state.ts";
import type { AgentConfig } from "../agent/types.ts";
import { buildContext } from "../context/builder.ts";
import { walkRepo } from "../context/walker.ts";
import type { ContextBundle } from "../context/types.ts";
import { contextBudgetFor } from "../models/context-budget.ts";
import type { LLMJudgeOptions } from "./graders/index.ts";
import { runGrader } from "./graders/index.ts";
import { averageMetrics, collectMetrics, computePassAllK, computePassAtK } from "./metrics.ts";
import { bootstrapCI } from "./stats.ts";
import { createTrialEnv } from "./trial-env.ts";
import type {
  EvalTask,
  GraderResult,
  PassAtKCI,
  TaskEvalResult,
  Transcript,
  TrialResult,
} from "./types.ts";

export interface TaskRunnerOptions {
  /** Sample count n — how many independent trials to run. Decoupled from the
   * reported k set below: report pass@k for k ≤ n, sampled from these n trials. */
  trialsPerTask: number;
  fixturesRoot: string;
  agentConfig: AgentConfig; // template; repoRoot overridden per trial
  loopDeps: LoopDependencies;
  graderOpts?: LLMJudgeOptions;
  /** Hard wall-clock deadline per trial in ms. Prevents hung test runners from blocking forever. Default: 10 min. */
  trialTimeoutMs?: number;
  /** Which k values to report pass@k for. Default [1,2,3,5]; n is always added
   * so the historical passAtK[n] key survives. Values > n are dropped. */
  reportKs?: number[];
  /** Bootstrap resamples for each CI. Default 2000. */
  bootstrapIters?: number;
  /** Seed for the CI bootstrap RNG (reproducible intervals). Default fixed. */
  ciSeed?: number;
}

// Option A toggle: pin the edit target + size-gate the format. Default on; set
// SMALLCODE_TARGET_PIN=0 to measure the pre-A baseline on the identical path.
const TARGET_PIN_ENABLED = process.env["SMALLCODE_TARGET_PIN"] !== "0";

// Build trial context via the SAME production retrieval the CLI uses: walkRepo
// (symbol-indexed repo map) → buildContext (query scoring, target pinning,
// size-gated edit format). Previously this reimplemented an ad-hoc dir-walk that
// diverged from production — so evals measured a retrieval path that never
// shipped. tokenBudget is the model's operative window minus the generation
// reserve, so trials feel the same context pressure as production.
export async function buildTrialContext(
  trialDir: string,
  query: string,
  tokenBudget: number,
): Promise<ContextBundle> {
  try {
    const repoMap = await walkRepo({ root: trialDir }, Date.now());
    return await buildContext(repoMap, query, {
      repoRoot: trialDir,
      tokenBudget,
      pinTarget: TARGET_PIN_ENABLED,
    });
  } catch {
    return { chunks: [], totalTokens: 0, tokenBudget, truncated: false, query };
  }
}

export async function runTask(task: EvalTask, opts: TaskRunnerOptions): Promise<TaskEvalResult> {
  const { trialsPerTask, fixturesRoot, agentConfig, loopDeps, graderOpts } = opts;
  const trialTimeoutMs = opts.trialTimeoutMs ?? 10 * 60 * 1000; // default 10 min
  const trials: TrialResult[] = [];

  for (let trialIndex = 0; trialIndex < trialsPerTask; trialIndex++) {
    const trialStartedAt = Date.now();
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const trialEnv = await createTrialEnv(task, fixturesRoot);
      cleanup = trialEnv.cleanup;

      // Override repoRoot with the trial dir
      const trialConfig: AgentConfig = {
        ...agentConfig,
        repoRoot: trialEnv.dir,
        statePath: join(trialEnv.dir, ".smallcode", "state.json"),
      };

      const state = createState(trialConfig, task.desc);
      const statePath = getStatePath(trialConfig);

      // Override provider/profile/config in loopDeps with trial config
      const trialDeps: LoopDependencies = {
        ...loopDeps,
        config: trialConfig,
      };

      const timeoutError = new Error(`Trial timed out after ${trialTimeoutMs / 1000}s`);
      const finalState = await Promise.race([
        runLoop(
          state,
          statePath,
          trialDeps,
          async (goal: string): Promise<ContextBundle> =>
            buildTrialContext(trialEnv.dir, goal, contextBudgetFor(loopDeps.profile)),
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(timeoutError), trialTimeoutMs)),
      ]);

      const trialFinishedAt = Date.now();

      const transcript: Transcript = {
        id: randomUUID(),
        sessionId: finalState.sessionId,
        taskId: task.id,
        trialIndex,
        modelId: finalState.modelId,
        turns: finalState.turns,
        outcome:
          finalState.status === "done"
            ? "passed"
            : finalState.status === "failed"
              ? "failed"
              : finalState.status === "max_turns"
                ? "timeout"
                : "error",
        startedAt: trialStartedAt,
        finishedAt: trialFinishedAt,
      };

      // Run all graders
      const graderResults: GraderResult[] = [];
      for (const graderConfig of task.graders) {
        try {
          const result = await runGrader(graderConfig, trialEnv.dir, transcript, graderOpts);
          graderResults.push(result);
        } catch (err) {
          graderResults.push({
            type: graderConfig.type,
            verdict: "error",
            score: 0,
            output: err instanceof Error ? err.message : String(err),
            durationMs: 0,
            details: { error: String(err) },
          });
        }
      }

      // Determine pass/fail and partial score
      const passed = graderResults.length === 0 || graderResults.every((r) => r.verdict === "pass");

      const partialScore =
        graderResults.length === 0
          ? 1
          : graderResults.reduce((sum, r) => sum + r.score, 0) / graderResults.length;

      const metrics = collectMetrics(transcript);

      trials.push({
        taskId: task.id,
        trialIndex,
        passed,
        partialScore,
        graderResults,
        transcript,
        metrics,
      });
    } catch (err) {
      // Build a minimal transcript for the failed trial
      const trialFinishedAt = Date.now();
      const errMsg = err instanceof Error ? err.message : String(err);

      const errorTranscript: Transcript = {
        id: randomUUID(),
        sessionId: randomUUID(),
        taskId: task.id,
        trialIndex,
        modelId: agentConfig.modelId,
        turns: [],
        outcome: "error",
        startedAt: trialStartedAt,
        finishedAt: trialFinishedAt,
        error: errMsg,
      };

      trials.push({
        taskId: task.id,
        trialIndex,
        passed: false,
        partialScore: 0,
        graderResults: [],
        transcript: errorTranscript,
        metrics: collectMetrics(errorTranscript),
        error: errMsg,
      });
    } finally {
      if (cleanup !== undefined) {
        try {
          await cleanup();
        } catch {
          // Best-effort cleanup — ignore errors
        }
      }
    }
  }

  // Compute aggregate metrics. The key fix: report pass@k for a SET of k from n
  // samples (n = trials.length) instead of only k=n, which collapsed the
  // unbiased estimator to a coarse binary. Each pass@k carries a bootstrap CI so
  // a point estimate can be told from noise.
  const n = trials.length;
  const passedFlags = trials.map((t) => t.passed);
  const passAt1 = trials.filter((t) => t.passed).length / Math.max(n, 1);

  // Report ks: requested set ∪ {n} (preserve the historical passAtK[n] key),
  // deduped, dropping any k > n.
  const requestedKs = opts.reportKs ?? [1, 2, 3, 5];
  const reportKs = [...new Set([...requestedKs, n])].filter((k) => k >= 1 && k <= n).sort((a, b) => a - b);

  const passAtK: Record<number, number> = {};
  const passAtKCI: Record<number, PassAtKCI> = {};
  for (const k of reportKs) {
    passAtK[k] = computePassAtK(trials, k);
    passAtKCI[k] = bootstrapCI(passedFlags, k, {
      iters: opts.bootstrapIters,
      seed: opts.ciSeed,
    });
  }

  const passAllK = computePassAllK(trials);
  const avgPartialScore =
    trials.reduce((sum, t) => sum + t.partialScore, 0) / Math.max(n, 1);
  const avgMetrics = averageMetrics(trials.map((t) => t.metrics));

  return {
    task,
    trials,
    passAt1,
    passAtK,
    passAllK,
    avgPartialScore,
    avgMetrics,
    n,
    passAtKCI,
  };
}
