import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LoopDependencies } from "../agent/loop.ts";
import { runLoop } from "../agent/loop.ts";
import { createState, getStatePath } from "../agent/state.ts";
import type { AgentConfig } from "../agent/types.ts";
import type { ContextBundle } from "../context/types.ts";
import type { LLMJudgeOptions } from "./graders/index.ts";
import { runGrader } from "./graders/index.ts";
import { averageMetrics, collectMetrics, computePassAllK, computePassAtK } from "./metrics.ts";
import { createTrialEnv } from "./trial-env.ts";
import type { EvalTask, GraderResult, TaskEvalResult, Transcript, TrialResult } from "./types.ts";

export interface TaskRunnerOptions {
  trialsPerTask: number;
  fixturesRoot: string;
  agentConfig: AgentConfig; // template; repoRoot overridden per trial
  loopDeps: LoopDependencies;
  graderOpts?: LLMJudgeOptions;
}

function buildEmptyContext(goal: string): ContextBundle {
  return {
    chunks: [],
    totalTokens: 0,
    tokenBudget: 0,
    truncated: false,
    query: goal,
  };
}

export async function runTask(task: EvalTask, opts: TaskRunnerOptions): Promise<TaskEvalResult> {
  const { trialsPerTask, fixturesRoot, agentConfig, loopDeps, graderOpts } = opts;
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

      const finalState = await runLoop(
        state,
        statePath,
        trialDeps,
        async (goal: string): Promise<ContextBundle> => buildEmptyContext(goal),
      );

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

  // Compute aggregate metrics
  const passAt1 = trials.filter((t) => t.passed).length / Math.max(trials.length, 1);
  const passAtK: Record<number, number> = {};
  passAtK[trialsPerTask] = computePassAtK(trials, trialsPerTask);

  const passAllK = computePassAllK(trials);
  const avgPartialScore =
    trials.reduce((sum, t) => sum + t.partialScore, 0) / Math.max(trials.length, 1);
  const avgMetrics = averageMetrics(trials.map((t) => t.metrics));

  return {
    task,
    trials,
    passAt1,
    passAtK,
    passAllK,
    avgPartialScore,
    avgMetrics,
  };
}
