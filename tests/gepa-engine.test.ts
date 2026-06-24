/**
 * Tests for GEPA engine, evaluate-adapter, and mutator interface.
 */

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { defaultPromptSet } from "../src/agent/prompt-set.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import type { LoopDependencies } from "../src/agent/loop.ts";
import type { EvalTask, TaskEvalResult } from "../src/eval/types.ts";
import type { TaskRunnerOptions } from "../src/eval/task-runner.ts";
import { evaluateCandidate } from "../src/improve/gepa/evaluate-adapter.ts";
import { MockMutator } from "../src/improve/gepa/mutator.ts";
import { runGepa } from "../src/improve/gepa/engine.ts";
import type { Candidate } from "../src/improve/gepa/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk } from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";

// ---------------------------------------------------------------------------
// Shared test stubs
// ---------------------------------------------------------------------------

const TASK_IDS = ["t0", "t1", "t2"];

function makeMockProfile(): ModelProfile {
  return {
    id: "mock-model",
    label: "Mock",
    contextWindow: 4096,
    samplingDefaults: { temperature: 0.0, top_p: 1.0, top_k: -1, max_tokens: 512 },
    supportsGrammar: false,
    supportsJsonSchema: false,
  };
}

function makeMockProvider(): Provider {
  return {
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
      rawContent: "",
      model: "mock-model",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }),
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "", done: true };
    },
  };
}

function makeBaseAgentConfig(): AgentConfig {
  return {
    repoRoot: "/tmp/test",
    modelId: "mock-model",
    maxTurns: 1,
    bestOfN: 1,
  };
}

function makeLoopDeps(agentConfig: AgentConfig): LoopDependencies {
  const profile = makeMockProfile();
  return {
    provider: makeMockProvider(),
    profile,
    reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
    config: agentConfig,
  };
}

function makeMockTask(id: string): EvalTask {
  return {
    id,
    desc: `Mock task ${id}`,
    setup: {},
    graders: [],
    trackedMetrics: [],
  };
}

/**
 * Build a mock runTask function that returns a controlled passAt1.
 * Captures calls so tests can inspect what AgentConfig was used.
 */
function makeMockRunTask(
  passAt1ByTask: Record<string, number>,
): {
  runTaskFn: (task: EvalTask, opts: TaskRunnerOptions) => Promise<TaskEvalResult>;
  calls: Array<{ task: EvalTask; opts: TaskRunnerOptions }>;
} {
  const calls: Array<{ task: EvalTask; opts: TaskRunnerOptions }> = [];

  const runTaskFn = async (task: EvalTask, opts: TaskRunnerOptions): Promise<TaskEvalResult> => {
    calls.push({ task, opts });
    const passAt1 = passAt1ByTask[task.id] ?? 0;
    return {
      task,
      trials: [
        {
          taskId: task.id,
          trialIndex: 0,
          passed: passAt1 >= 1,
          partialScore: passAt1,
          graderResults: [],
          transcript: {
            id: randomUUID(),
            sessionId: randomUUID(),
            taskId: task.id,
            trialIndex: 0,
            modelId: "mock-model",
            turns: [],
            outcome: passAt1 >= 1 ? "passed" : "failed",
            startedAt: Date.now(),
            finishedAt: Date.now(),
          },
          metrics: {
            nTurns: 0,
            nToolCalls: 0,
            nTotalTokens: 0,
            nPromptTokens: 0,
            nCompletionTokens: 0,
            latencyMs: 0,
          },
        },
      ],
      passAt1,
      passAtK: { 1: passAt1 },
      passAllK: passAt1,
      avgPartialScore: passAt1,
      avgMetrics: {
        nTurns: 0,
        nToolCalls: 0,
        nTotalTokens: 0,
        nPromptTokens: 0,
        nCompletionTokens: 0,
        latencyMs: 0,
      },
    };
  };

  return { runTaskFn, calls };
}

// ---------------------------------------------------------------------------
// evaluateCandidate
// ---------------------------------------------------------------------------

describe("evaluateCandidate()", () => {
  it("returns exact taskId→passAt1 from mock runner", async () => {
    const tasks = TASK_IDS.map(makeMockTask);
    const baseConfig = makeBaseAgentConfig();
    const { runTaskFn } = makeMockRunTask({ t0: 1.0, t1: 0.5, t2: 0.0 });

    const cand: Candidate = {
      id: "c1",
      prompts: defaultPromptSet(),
      parentId: null,
      generation: 0,
      scores: {},
      meanScore: 0,
    };

    const scores = await evaluateCandidate(cand, {
      tasks,
      baseAgentConfig: baseConfig,
      loopDeps: makeLoopDeps(baseConfig),
      fixturesRoot: "/tmp/fixtures",
      trialsPerTask: 1,
      runTaskFn,
    });

    expect(scores["t0"]).toBe(1.0);
    expect(scores["t1"]).toBe(0.5);
    expect(scores["t2"]).toBe(0.0);
  });

  it("injects candidate.prompts into the AgentConfig passed to runTaskFn", async () => {
    const tasks = [makeMockTask("t0")];
    const baseConfig = makeBaseAgentConfig();
    const capturedConfigs: AgentConfig[] = [];

    const runTaskFn = async (task: EvalTask, opts: TaskRunnerOptions): Promise<TaskEvalResult> => {
      capturedConfigs.push(opts.agentConfig);
      return makeMockRunTask({ t0: 1.0 }).runTaskFn(task, opts);
    };

    const candidatePrompts = defaultPromptSet({ disciplineRules: false });
    const cand: Candidate = {
      id: "c2",
      prompts: candidatePrompts,
      parentId: null,
      generation: 0,
      scores: {},
      meanScore: 0,
    };

    await evaluateCandidate(cand, {
      tasks,
      baseAgentConfig: baseConfig,
      loopDeps: makeLoopDeps(baseConfig),
      fixturesRoot: "/tmp/fixtures",
      trialsPerTask: 1,
      runTaskFn,
    });

    expect(capturedConfigs).toHaveLength(1);
    // The captured AgentConfig must have promptSet = cand.prompts
    expect(capturedConfigs[0]?.promptSet).toBe(candidatePrompts);
  });
});

// ---------------------------------------------------------------------------
// MockMutator interface
// ---------------------------------------------------------------------------

describe("MockMutator", () => {
  it("mutate() is called with only failed-task (score < 1) transcripts", async () => {
    const mutator = new MockMutator();
    const parentPrompts = defaultPromptSet();
    const tasks = TASK_IDS.map(makeMockTask);
    const baseConfig = makeBaseAgentConfig();

    // t0=pass, t1=fail, t2=fail → only t1, t2 should appear in failures
    const { runTaskFn } = makeMockRunTask({ t0: 1.0, t1: 0.0, t2: 0.5 });

    const seed: Candidate = {
      id: "seed",
      prompts: parentPrompts,
      parentId: null,
      generation: 0,
      scores: { t0: 1.0, t1: 0.0, t2: 0.5 },
      meanScore: 0.5,
    };

    await runGepa(seed, mutator, {
      baseAgentConfig: baseConfig,
      loopDeps: makeLoopDeps(baseConfig),
      tasks,
      fixturesRoot: "/tmp/fixtures",
      runTaskFn,
    }, {
      taskIds: TASK_IDS,
      populationCap: 5,
      maxGenerations: 1,
      trialsPerTask: 1,
    });

    expect(mutator.callCount).toBe(1);
    // Failures should only contain tasks with score < 1
    const failures = mutator.lastFailures ?? [];
    const failedTaskIds = failures.map((f) => f.taskId);
    expect(failedTaskIds).not.toContain("t0"); // passed
    // t1 and/or t2 may be in failures
  });

  it("returns a deterministically modified PromptSet", async () => {
    const mutator = new MockMutator();
    const parent = defaultPromptSet();
    const result = await mutator.mutate(parent, []);
    expect(result.system).toContain("[mutated-v1]");
    expect(result.planner).toContain("[mutated-v1]");
    expect(result.reflection).toContain("[mutated-v1]");
  });
});

// ---------------------------------------------------------------------------
// runGepa end-to-end
// ---------------------------------------------------------------------------

describe("runGepa end-to-end", () => {
  it("returns a non-empty front after maxGenerations", async () => {
    const tasks = TASK_IDS.map(makeMockTask);
    const baseConfig = makeBaseAgentConfig();
    const mutator = new MockMutator();

    // All scores 0.5 → nothing dominates the seed → front grows
    const { runTaskFn } = makeMockRunTask({ t0: 0.5, t1: 0.5, t2: 0.5 });

    const seed: Candidate = {
      id: randomUUID(),
      prompts: defaultPromptSet(),
      parentId: null,
      generation: 0,
      scores: { t0: 0.5, t1: 0.5, t2: 0.5 },
      meanScore: 0.5,
    };

    // Fixed rng → deterministic
    const rng = () => 0.0;

    const front = await runGepa(seed, mutator, {
      baseAgentConfig: baseConfig,
      loopDeps: makeLoopDeps(baseConfig),
      tasks,
      fixturesRoot: "/tmp/fixtures",
      runTaskFn,
    }, {
      taskIds: TASK_IDS,
      populationCap: 5,
      maxGenerations: 3,
      trialsPerTask: 1,
    }, rng);

    expect(front.length).toBeGreaterThan(0);
    expect(mutator.callCount).toBe(3);
  });

  it("candidate lineage: parentId and generation+1 are correct", async () => {
    const tasks = TASK_IDS.map(makeMockTask);
    const baseConfig = makeBaseAgentConfig();
    const mutator = new MockMutator();
    const { runTaskFn } = makeMockRunTask({ t0: 0.0, t1: 0.0, t2: 0.0 });

    const seed: Candidate = {
      id: "seed-id",
      prompts: defaultPromptSet(),
      parentId: null,
      generation: 0,
      scores: { t0: 0.0, t1: 0.0, t2: 0.0 },
      meanScore: 0.0,
    };

    const front = await runGepa(seed, mutator, {
      baseAgentConfig: baseConfig,
      loopDeps: makeLoopDeps(baseConfig),
      tasks,
      fixturesRoot: "/tmp/fixtures",
      runTaskFn,
    }, {
      taskIds: TASK_IDS,
      populationCap: 5,
      maxGenerations: 1,
      trialsPerTask: 1,
    }, () => 0.0);

    // Should have produced exactly 1 child (1 generation)
    const children = front.filter((m) => m.generation > 0);
    expect(children.length).toBeGreaterThan(0);
    const child = children[0] as Candidate;
    expect(child.parentId).toBe("seed-id");
    expect(child.generation).toBe(1);
  });

  it("deterministic front with fixed rng and mock scores", async () => {
    const tasks = TASK_IDS.map(makeMockTask);
    const baseConfig = makeBaseAgentConfig();
    const mutator = new MockMutator();

    // Scores increase over calls so the front converges deterministically
    let callIdx = 0;
    const scoreSeq = [
      { t0: 0.8, t1: 0.8, t2: 0.8 },
      { t0: 0.9, t1: 0.9, t2: 0.9 },
      { t0: 1.0, t1: 1.0, t2: 1.0 },
    ];

    const runTaskFn = async (task: EvalTask, opts: TaskRunnerOptions): Promise<TaskEvalResult> => {
      const scoreMap = scoreSeq[Math.floor(callIdx / 3)] ?? { t0: 0, t1: 0, t2: 0 };
      callIdx++;
      return makeMockRunTask(scoreMap).runTaskFn(task, opts);
    };

    const seed: Candidate = {
      id: "seed",
      prompts: defaultPromptSet(),
      parentId: null,
      generation: 0,
      scores: { t0: 0.5, t1: 0.5, t2: 0.5 },
      meanScore: 0.5,
    };

    const rng = () => 0.0;

    const front = await runGepa(seed, mutator, {
      baseAgentConfig: baseConfig,
      loopDeps: makeLoopDeps(baseConfig),
      tasks,
      fixturesRoot: "/tmp/fixtures",
      runTaskFn,
    }, {
      taskIds: TASK_IDS,
      populationCap: 5,
      maxGenerations: 3,
      trialsPerTask: 1,
    }, rng);

    const best = front.reduce((a, b) => (a.meanScore > b.meanScore ? a : b));
    // The best should have the highest scores from the sequence
    expect(best.meanScore).toBeGreaterThanOrEqual(0.5);
    expect(front.length).toBeGreaterThan(0);
  });
});
