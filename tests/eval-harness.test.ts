import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopDependencies } from "../src/agent/loop.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import { collectMetrics, computePassAllK, computePassAtK } from "../src/eval/metrics.ts";
import { runTask } from "../src/eval/task-runner.ts";
import { TranscriptStore } from "../src/eval/transcript-store.ts";
import { createTrialEnv } from "../src/eval/trial-env.ts";
import type { EvalTask, Transcript, TrialResult } from "../src/eval/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  StreamChunk,
} from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTranscript(overrides: Partial<Transcript> = {}): Transcript {
  const now = Date.now();
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    taskId: "task-1",
    trialIndex: 0,
    modelId: "test-model",
    turns: [],
    outcome: "passed",
    startedAt: now - 1000,
    finishedAt: now,
    ...overrides,
  };
}

function makeTrialResult(passed: boolean, overrides: Partial<TrialResult> = {}): TrialResult {
  const transcript = makeTranscript();
  return {
    taskId: "task-1",
    trialIndex: 0,
    passed,
    partialScore: passed ? 1 : 0,
    graderResults: [],
    transcript,
    metrics: {
      nTurns: 0,
      nToolCalls: 0,
      nTotalTokens: 0,
      nPromptTokens: 0,
      nCompletionTokens: 0,
      latencyMs: 1000,
    },
    ...overrides,
  };
}

function makeProvider(responseText: string): Provider {
  return {
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
      rawContent: responseText,
      model: "test-model",
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
      finishReason: "stop",
    }),
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: responseText, done: true };
    },
  };
}

function makeModelProfile(): ModelProfile {
  return {
    id: "test-model",
    label: "Test Model",
    contextWindow: 4096,
    samplingDefaults: { temperature: 0.7, top_p: 0.9, top_k: -1, max_tokens: 512 },
    supportsGrammar: false,
    supportsJsonSchema: false,
  };
}

function makeAgentConfig(repoRoot: string): AgentConfig {
  return {
    repoRoot,
    modelId: "test-model",
    maxTurns: 2,
    bestOfN: 1,
  };
}

function makeLoopDeps(repoRoot: string): LoopDependencies {
  // Use a trivial provider that immediately returns a "finish" tool call so the loop exits
  const finishResponse = "Done.\nTOOL: finish {}";
  return {
    provider: makeProvider(finishResponse),
    profile: makeModelProfile(),
    reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
    config: makeAgentConfig(repoRoot),
  };
}

// ---------------------------------------------------------------------------
// Test directory setup
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `eval-harness-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. createTrialEnv with inline files creates them in temp dir
// ---------------------------------------------------------------------------

describe("createTrialEnv", () => {
  it("creates inline files in temp dir", async () => {
    const task: EvalTask = {
      id: "test-task",
      desc: "Test task",
      setup: {
        files: {
          "src/hello.ts": 'export const hello = "world";',
          "src/nested/deep.ts": "export const x = 1;",
        },
      },
      graders: [],
      trackedMetrics: [],
    };

    const env = await createTrialEnv(task, testDir);
    try {
      // Verify files were created
      await access(join(env.dir, "src/hello.ts"));
      await access(join(env.dir, "src/nested/deep.ts"));

      // Verify dir exists
      const s = await stat(env.dir);
      expect(s.isDirectory()).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // 2. createTrialEnv cleanup removes the dir
  // ---------------------------------------------------------------------------

  it("cleanup removes the temp dir", async () => {
    const task: EvalTask = {
      id: "cleanup-task",
      desc: "Cleanup test",
      setup: {},
      graders: [],
      trackedMetrics: [],
    };

    const env = await createTrialEnv(task, testDir);
    const dir = env.dir;

    // Dir should exist before cleanup
    const beforeStat = await stat(dir);
    expect(beforeStat.isDirectory()).toBe(true);

    await env.cleanup();

    // Dir should be gone after cleanup
    let threw = false;
    try {
      await stat(dir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. collectMetrics extracts correct counts from a mock transcript
// ---------------------------------------------------------------------------

describe("collectMetrics", () => {
  it("extracts correct counts from a mock transcript", () => {
    const now = Date.now();
    const transcript = makeTranscript({
      startedAt: now - 5000,
      finishedAt: now,
      turns: [
        {
          turn: 1,
          goalId: "g1",
          prompt: "p1",
          rawResponse: "r1",
          answer: "a1",
          toolCalls: [
            { name: "read_file", args: {} },
            { name: "write_file", args: {} },
          ],
          toolResults: [],
          editBlocks: [],
          applyResults: [],
          promptTokens: 100,
          completionTokens: 50,
          timestamp: now - 4000,
        },
        {
          turn: 2,
          goalId: "g1",
          prompt: "p2",
          rawResponse: "r2",
          answer: "a2",
          toolCalls: [{ name: "finish", args: {} }],
          toolResults: [],
          editBlocks: [],
          applyResults: [],
          promptTokens: 200,
          completionTokens: 75,
          timestamp: now - 2000,
        },
      ],
    });

    const metrics = collectMetrics(transcript);

    expect(metrics.nTurns).toBe(2);
    expect(metrics.nToolCalls).toBe(3); // 2 + 1
    expect(metrics.nPromptTokens).toBe(300); // 100 + 200
    expect(metrics.nCompletionTokens).toBe(125); // 50 + 75
    expect(metrics.nTotalTokens).toBe(425); // 300 + 125
    expect(metrics.latencyMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// 4–6. computePassAtK tests
// ---------------------------------------------------------------------------

describe("computePassAtK", () => {
  it("k=1, 1 trial pass → returns 1.0", () => {
    const trials = [makeTrialResult(true)];
    expect(computePassAtK(trials, 1)).toBe(1);
  });

  it("k=1, 0 trials pass → returns 0.0", () => {
    const trials = [makeTrialResult(false)];
    expect(computePassAtK(trials, 1)).toBe(0);
  });

  it("k=2, 1/2 trials pass → returns ~0.5", () => {
    const trials = [makeTrialResult(true), makeTrialResult(false)];
    const result = computePassAtK(trials, 2);
    // With n=2, c=1, k=2: 1 - C(1,2)/C(2,2) = 1 - 0/1 = 1
    // k clamped to n=2; n-c=1 < k=2 → returns 1
    // Actually: 1 - C(n-c,k)/C(n,k) = 1 - C(1,2)/C(2,2) = 1 - 0 = 1
    // But k clamped: kClamped = min(2,2) = 2; nc=1 < kClamped=2 → return 1
    // For pass@1 with same data:
    const passAt1 = computePassAtK(trials, 1);
    // 1 - C(1,1)/C(2,1) = 1 - 1/2 = 0.5
    expect(passAt1).toBeCloseTo(0.5, 5);
    // pass@2 when 1/2 pass: nc=1 < k=2, returns 1
    expect(result).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7–8. computePassAllK tests
// ---------------------------------------------------------------------------

describe("computePassAllK", () => {
  it("all passing → 1.0", () => {
    const trials = [makeTrialResult(true), makeTrialResult(true), makeTrialResult(true)];
    expect(computePassAllK(trials)).toBe(1);
  });

  it("none passing → 0.0", () => {
    const trials = [makeTrialResult(false), makeTrialResult(false)];
    expect(computePassAllK(trials)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9–11. TranscriptStore tests
// ---------------------------------------------------------------------------

describe("TranscriptStore", () => {
  it("save + load round-trips correctly", async () => {
    const store = new TranscriptStore(testDir);
    const transcript = makeTranscript({
      id: randomUUID(),
      taskId: "round-trip-task",
      trialIndex: 0,
      outcome: "passed",
    });

    await store.save(transcript);
    const loaded = await store.load(transcript.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(transcript.id);
    expect(loaded?.taskId).toBe(transcript.taskId);
    expect(loaded?.outcome).toBe(transcript.outcome);
    expect(loaded?.startedAt).toBe(transcript.startedAt);
  });

  it("list returns metadata for saved transcripts", async () => {
    const store = new TranscriptStore(testDir);
    const t1 = makeTranscript({ id: randomUUID(), taskId: "list-task", trialIndex: 0 });
    const t2 = makeTranscript({ id: randomUUID(), taskId: "list-task", trialIndex: 1 });

    await store.save(t1);
    await store.save(t2);

    const listing = await store.list();
    expect(listing.length).toBe(2);

    const ids = listing.map((m) => m.id);
    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);
  });

  it("list with taskId filter returns only matching", async () => {
    const store = new TranscriptStore(testDir);
    const t1 = makeTranscript({ id: randomUUID(), taskId: "task-alpha" });
    const t2 = makeTranscript({ id: randomUUID(), taskId: "task-beta" });

    await store.save(t1);
    await store.save(t2);

    const alphaOnly = await store.list("task-alpha");
    expect(alphaOnly.length).toBe(1);
    expect(alphaOnly[0]?.taskId).toBe("task-alpha");

    const betaOnly = await store.list("task-beta");
    expect(betaOnly.length).toBe(1);
    expect(betaOnly[0]?.taskId).toBe("task-beta");
  });
});

// ---------------------------------------------------------------------------
// 12. runTask mock: task with no graders, trivial agent → TrialResult with no errors
// ---------------------------------------------------------------------------

describe("runTask", () => {
  it("task with no graders, trivial agent → TrialResult with no errors", async () => {
    const task: EvalTask = {
      id: "no-graders-task",
      desc: "Trivial task with no graders",
      setup: {},
      graders: [],
      trackedMetrics: [],
    };

    const agentConfig = makeAgentConfig(testDir);
    const loopDeps = makeLoopDeps(testDir);

    const result = await runTask(task, {
      trialsPerTask: 1,
      fixturesRoot: testDir,
      agentConfig,
      loopDeps,
    });

    expect(result.task.id).toBe("no-graders-task");
    expect(result.trials.length).toBe(1);

    const trial = result.trials[0];
    expect(trial).toBeDefined();
    expect(trial?.error).toBeUndefined();
    expect(trial?.graderResults.length).toBe(0);
    // No graders → passed = true (vacuously)
    expect(trial?.passed).toBe(true);
  });
});
