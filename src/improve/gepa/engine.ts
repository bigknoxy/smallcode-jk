/**
 * GEPA evolution engine (2b).
 *
 * runGepa drives the reflective prompt evolution loop:
 *   For each generation:
 *     1. Select a parent from the Pareto front (GEPA weighting).
 *     2. Identify failed task instances (scores[taskId] < 1).
 *     3. Call the mutator with the parent prompts + failed-task transcripts.
 *     4. Score the mutated candidate with evaluateCandidate.
 *     5. Wrap it as a Candidate (parentId, generation, scores, meanScore).
 *     6. Attempt to add it to the Pareto front.
 *   Stop after maxGenerations.  Returns the final front members.
 */

import { randomUUID } from "node:crypto";
import type { LoopDependencies } from "../../agent/loop.ts";
import type { AgentConfig } from "../../agent/types.ts";
import type { EvalTask, TaskEvalResult, Transcript } from "../../eval/types.ts";
import type { TaskRunnerOptions } from "../../eval/task-runner.ts";
import { evaluateCandidate } from "./evaluate-adapter.ts";
import { ParetoFront } from "./pareto-front.ts";
import type { ReflectiveMutator } from "./mutator.ts";
import type { Candidate, FailedInstance, GepaConfig } from "./types.ts";

export interface GepaEngineDeps {
  /** Base AgentConfig for eval runs (repoRoot/promptSet overridden per trial). */
  baseAgentConfig: AgentConfig;
  /** Loop dependencies for the eval runner. */
  loopDeps: LoopDependencies;
  /** EvalTasks to score candidates against (should match cfg.taskIds). */
  tasks: EvalTask[];
  /** Root directory for eval fixtures. */
  fixturesRoot: string;
  /** Injectable runTask — defaults to the real eval runner. */
  runTaskFn?: (task: EvalTask, opts: TaskRunnerOptions) => Promise<TaskEvalResult>;
}

/**
 * Run the GEPA evolution loop.
 *
 * @param seed         Initial candidate (generation 0, parentId null).
 * @param mutator      Reflective mutator (injectable for tests).
 * @param evalDeps     Dependencies for evaluateCandidate.
 * @param cfg          GEPA hyper-parameters (taskIds, populationCap, maxGenerations, trialsPerTask).
 * @param rng          Optional deterministic RNG (defaults to Math.random).
 * @returns The final Pareto front members.
 */
export async function runGepa(
  seed: Candidate,
  mutator: ReflectiveMutator,
  evalDeps: GepaEngineDeps,
  cfg: GepaConfig,
  rng: () => number = Math.random,
): Promise<Candidate[]> {
  const front = new ParetoFront(cfg.taskIds, cfg.populationCap);
  front.add(seed);

  for (let gen = 0; gen < cfg.maxGenerations; gen++) {
    // 1. Select parent from front
    const parent = front.select(rng);

    // 2. Gather failed-task transcripts from the parent's last eval.
    //    We re-evaluate the parent to get fresh transcripts for the mutation
    //    reflection step.  Failed = score < 1.
    const failedInstances: FailedInstance[] = [];
    const failedTaskIds = cfg.taskIds.filter((tid) => (parent.scores[tid] ?? 0) < 1);

    if (failedTaskIds.length > 0) {
      // Re-evaluate just the failed tasks to get transcripts
      const failedTasks = evalDeps.tasks.filter((t) => failedTaskIds.includes(t.id));

      for (const task of failedTasks) {
        const runFn = evalDeps.runTaskFn ?? (await import("../../eval/task-runner.ts")).runTask;
        const taskAgentConfig: AgentConfig = {
          ...evalDeps.baseAgentConfig,
          promptSet: parent.prompts,
        };
        const taskLoopDeps: LoopDependencies = {
          ...evalDeps.loopDeps,
          config: taskAgentConfig,
        };
        const opts: TaskRunnerOptions = {
          trialsPerTask: 1, // single trial for transcript collection
          fixturesRoot: evalDeps.fixturesRoot,
          agentConfig: taskAgentConfig,
          loopDeps: taskLoopDeps,
        };

        try {
          const result = await runFn(task, opts);
          // Collect the first transcript (trial 0)
          const transcript: Transcript | undefined = result.trials[0]?.transcript;
          if (transcript !== undefined) {
            failedInstances.push({ taskId: task.id, transcript });
          }
        } catch {
          // Non-fatal — proceed without transcript for this task
        }
      }
    }

    // 3. Mutate
    const mutatedPrompts = await mutator.mutate(parent.prompts, failedInstances);

    // 4. Score the mutated candidate
    const mutatedCandidate: Candidate = {
      id: randomUUID(),
      prompts: mutatedPrompts,
      parentId: parent.id,
      generation: parent.generation + 1,
      scores: {},
      meanScore: 0,
    };

    const scores = await evaluateCandidate(mutatedCandidate, {
      tasks: evalDeps.tasks,
      baseAgentConfig: evalDeps.baseAgentConfig,
      loopDeps: evalDeps.loopDeps,
      fixturesRoot: evalDeps.fixturesRoot,
      trialsPerTask: cfg.trialsPerTask,
      runTaskFn: evalDeps.runTaskFn,
    });

    mutatedCandidate.scores = scores;
    mutatedCandidate.meanScore =
      cfg.taskIds.length === 0
        ? 0
        : cfg.taskIds.reduce((sum, tid) => sum + (scores[tid] ?? 0), 0) / cfg.taskIds.length;

    // 5. Attempt to add to front (evicts dominated members)
    front.add(mutatedCandidate);
  }

  return front.members();
}
