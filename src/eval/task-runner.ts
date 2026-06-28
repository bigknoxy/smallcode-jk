import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runBestOfNLoop, defaultTemperatures } from "../agent/bestofn-loop.ts";
import type { LoopDependencies } from "../agent/loop.ts";
import { runLoop } from "../agent/loop.ts";
import { createState, getStatePath } from "../agent/state.ts";
import type { AgentConfig, AgentState } from "../agent/types.ts";
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
  /** Run-level oracle-verified Best-of-N: each trial runs up to N independent
   * full agent-loop attempts (fresh env each, temperature-swept for diversity)
   * and resolves on the FIRST attempt whose graders all pass — the deterministic
   * test grader is a sound oracle, so any-attempt-green == solved with zero
   * selection error. Default 1 (a plain single-shot trial). */
  bestOfN?: number;
  /** Per-attempt temperatures for Best-of-N. Defaults to defaultTemperatures(N),
   * a sweep around 1.0 in [0.7, 1.3]. Ignored when bestOfN ≤ 1. */
  bonTemperatures?: number[];
}

// Map an AgentState's terminal status to a transcript outcome. Shared by the
// single-shot and Best-of-N trial paths so both record outcomes identically.
function buildTranscript(
  state: AgentState,
  taskId: string,
  trialIndex: number,
  startedAt: number,
  finishedAt: number,
): Transcript {
  return {
    id: randomUUID(),
    sessionId: state.sessionId,
    taskId,
    trialIndex,
    modelId: state.modelId,
    turns: state.turns,
    outcome:
      state.status === "done"
        ? "passed"
        : state.status === "failed"
          ? "failed"
          : state.status === "max_turns"
            ? "timeout"
            : "error",
    startedAt,
    finishedAt,
  };
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

// Run-level oracle-verified Best-of-N for ONE trial: up to N independent full
// agent-loop attempts (fresh env each, temperature-swept), resolving on the
// first attempt whose graders all pass. Reuses runBestOfNLoop (the same
// mechanism the CLI ships) so the eval measures production behaviour. The
// deterministic test grader is the sound oracle; verify runs the full grader
// set per attempt and stashes the verdicts so the winner needs no re-grade.
async function runBonTrial(
  task: EvalTask,
  opts: TaskRunnerOptions,
  trialIndex: number,
  trialStartedAt: number,
  bestOfN: number,
  cleanups: Array<() => Promise<void>>,
): Promise<TrialResult> {
  const { fixturesRoot, agentConfig, loopDeps, graderOpts } = opts;
  const temps = opts.bonTemperatures ?? defaultTemperatures(bestOfN);

  const attemptDirs: string[] = [];
  const attemptStates: AgentState[] = [];
  const attemptGrades: GraderResult[][] = [];

  const bon = await runBestOfNLoop({
    n: bestOfN,
    temperatures: temps,
    deps: { ...loopDeps, config: agentConfig },
    setup: async (attempt) => {
      const env = await createTrialEnv(task, fixturesRoot);
      cleanups.push(env.cleanup);
      attemptDirs[attempt] = env.dir;
      const trialConfig: AgentConfig = {
        ...agentConfig,
        repoRoot: env.dir,
        statePath: join(env.dir, ".smallcode", "state.json"),
      };
      const state = createState(trialConfig, task.desc);
      attemptStates[attempt] = state;
      return {
        state,
        statePath: getStatePath(trialConfig),
        getContext: async (goal: string): Promise<ContextBundle> =>
          buildTrialContext(env.dir, goal, contextBudgetFor(loopDeps.profile)),
      };
    },
    verify: async (attempt) => {
      const dir = attemptDirs[attempt]!;
      const state = attemptStates[attempt]!;
      const transcript = buildTranscript(state, task.id, trialIndex, trialStartedAt, Date.now());
      const grades: GraderResult[] = [];
      for (const graderConfig of task.graders) {
        try {
          grades.push(await runGrader(graderConfig, dir, transcript, graderOpts));
        } catch (err) {
          grades.push({
            type: graderConfig.type,
            verdict: "error",
            score: 0,
            output: err instanceof Error ? err.message : String(err),
            durationMs: 0,
            details: { error: String(err) },
          });
        }
      }
      attemptGrades[attempt] = grades;
      return grades.length === 0 || grades.every((r) => r.verdict === "pass");
    },
  });

  // Winner = first green; if none passed, the last attempt run is recorded as
  // the trial's (failed) outcome.
  const winIdx = bon.winningAttempt ?? bon.attemptsUsed - 1;
  const winState = bon.states[winIdx] ?? attemptStates[winIdx]!;
  const graderResults = attemptGrades[winIdx] ?? [];
  const passed = bon.passed;
  const partialScore =
    graderResults.length === 0
      ? passed
        ? 1
        : 0
      : graderResults.reduce((sum, r) => sum + r.score, 0) / graderResults.length;
  const transcript = buildTranscript(winState, task.id, trialIndex, trialStartedAt, Date.now());

  return {
    taskId: task.id,
    trialIndex,
    passed,
    partialScore,
    graderResults,
    transcript,
    metrics: collectMetrics(transcript),
    attemptsUsed: bon.attemptsUsed,
  };
}

export async function runTask(task: EvalTask, opts: TaskRunnerOptions): Promise<TaskEvalResult> {
  const { trialsPerTask, fixturesRoot, agentConfig, loopDeps, graderOpts } = opts;
  const trialTimeoutMs = opts.trialTimeoutMs ?? 10 * 60 * 1000; // default 10 min
  const trials: TrialResult[] = [];

  for (let trialIndex = 0; trialIndex < trialsPerTask; trialIndex++) {
    const trialStartedAt = Date.now();
    const bestOfN = opts.bestOfN ?? 1;
    // Best-of-N spins up one env per attempt; collect every cleanup so finally
    // tears them all down (single-shot pushes exactly one).
    const cleanups: Array<() => Promise<void>> = [];

    try {
      if (bestOfN > 1) {
        trials.push(
          await runBonTrial(task, opts, trialIndex, trialStartedAt, bestOfN, cleanups),
        );
        continue;
      }

      const trialEnv = await createTrialEnv(task, fixturesRoot);
      cleanups.push(trialEnv.cleanup);

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

      const transcript = buildTranscript(
        finalState,
        task.id,
        trialIndex,
        trialStartedAt,
        trialFinishedAt,
      );

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
      for (const cleanup of cleanups) {
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

  // Best-of-N cost: mean attempts spent per trial (≤ N via first-green stop).
  const bestOfN = opts.bestOfN ?? 1;
  const avgAttemptsUsed =
    bestOfN > 1 && n > 0
      ? trials.reduce((sum, t) => sum + (t.attemptsUsed ?? 1), 0) / n
      : undefined;

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
    ...(bestOfN > 1 ? { bestOfN } : {}),
    ...(avgAttemptsUsed !== undefined ? { avgAttemptsUsed } : {}),
  };
}
