/**
 * Candidate evaluation adapter (2b).
 *
 * evaluateCandidate scores a Candidate against a set of EvalTasks by calling
 * runTask (or a mock substitute) with an AgentConfig that has candidate.prompts
 * injected as `promptSet`.  Returns a taskId → passAt1 map.
 */

import type { LoopDependencies } from "../../agent/loop.ts";
import type { AgentConfig } from "../../agent/types.ts";
import type { EvalTask, TaskEvalResult } from "../../eval/types.ts";
import { runTask } from "../../eval/task-runner.ts";
import type { TaskRunnerOptions } from "../../eval/task-runner.ts";
import type { Candidate } from "./types.ts";

export interface EvaluateAdapterDeps {
  /** Eval tasks to score the candidate against. */
  tasks: EvalTask[];
  /** Base AgentConfig — repoRoot and promptSet will be overridden per trial. */
  baseAgentConfig: AgentConfig;
  /** LoopDependencies shared across all eval runs. */
  loopDeps: LoopDependencies;
  /** Root directory for eval fixtures. */
  fixturesRoot: string;
  /** Number of trials per task (from GepaConfig). */
  trialsPerTask: number;
  /**
   * Injectable runTask function.  Defaults to the real eval task-runner.
   * Swap for a mock in unit tests so no model calls are made.
   */
  runTaskFn?: (task: EvalTask, opts: TaskRunnerOptions) => Promise<TaskEvalResult>;
}

/**
 * Score a candidate against each task in deps.tasks.
 *
 * The candidate's PromptSet is injected into the AgentConfig via the
 * `promptSet` field, so the executor + planner + reflection steps all
 * use the candidate's prompt variants.
 *
 * Returns a Record<taskId, passAt1>.
 */
export async function evaluateCandidate(
  cand: Candidate,
  deps: EvaluateAdapterDeps,
): Promise<Record<string, number>> {
  const runFn = deps.runTaskFn ?? runTask;
  const scores: Record<string, number> = {};

  for (const task of deps.tasks) {
    // Inject candidate's prompts into the agent config
    const taskAgentConfig: AgentConfig = {
      ...deps.baseAgentConfig,
      promptSet: cand.prompts,
    };

    const taskLoopDeps: LoopDependencies = {
      ...deps.loopDeps,
      config: taskAgentConfig,
    };

    const opts: TaskRunnerOptions = {
      trialsPerTask: deps.trialsPerTask,
      fixturesRoot: deps.fixturesRoot,
      agentConfig: taskAgentConfig,
      loopDeps: taskLoopDeps,
    };

    const result = await runFn(task, opts);
    scores[task.id] = result.passAt1;
  }

  return scores;
}
