import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { LoopDependencies } from "../agent/loop.ts";
import { runLoop } from "../agent/loop.ts";
import { createState, getStatePath } from "../agent/state.ts";
import type { AgentConfig } from "../agent/types.ts";
import { estimateTokens } from "../context/tokens.ts";
import type { ContextBundle, ContextChunk } from "../context/types.ts";
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

// Walk trial dir and return source files as context chunks.
// Includes .ts/.js/.py source files but not node_modules or lock files.
async function buildTrialContext(trialDir: string, query: string): Promise<ContextBundle> {
  const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]);
  const SKIP_DIRS = new Set(["node_modules", ".git", ".smallcode"]);

  const chunks: ContextChunk[] = [];
  let totalTokens = 0;
  const TOKEN_BUDGET = 8_000;

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir, { encoding: "utf-8" });
    } catch {
      return;
    }
    for (const name of entries) {
      const absPath = join(dir, name);
      // Check if directory
      let isDir = false;
      try {
        const s = await lstat(absPath);
        isDir = s.isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(name)) await walk(absPath);
        continue;
      }
      const ext = name.slice(name.lastIndexOf("."));
      if (!SOURCE_EXTS.has(ext)) continue;
      const relPath = relative(trialDir, absPath);
      try {
        const content = await readFile(absPath, { encoding: "utf-8" });
        const lines = content.split("\n");
        const tokens = estimateTokens(content);
        if (totalTokens + tokens > TOKEN_BUDGET) continue;
        totalTokens += tokens;
        chunks.push({
          filePath: relPath,
          content,
          startLine: 1,
          endLine: lines.length,
          estimatedTokens: tokens,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  await walk(trialDir);

  return {
    chunks,
    totalTokens,
    tokenBudget: TOKEN_BUDGET,
    truncated: false,
    query,
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
        async (goal: string): Promise<ContextBundle> => buildTrialContext(trialEnv.dir, goal),
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
