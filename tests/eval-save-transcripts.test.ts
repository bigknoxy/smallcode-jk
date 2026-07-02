import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/config/env.ts";
import { saveTrialTranscripts } from "../src/eval/save-transcripts.ts";
import { TranscriptStore } from "../src/eval/transcript-store.ts";
import type { TaskEvalResult, Transcript, TrialResult } from "../src/eval/types.ts";

// Issue #95: `eval run --save-transcripts` must persist every trial's
// Transcript into the TranscriptStore layout (<transcriptsDir>/<taskId>/<id>.json)
// so scripts/classify-pass-quality.ts has real data to classify. These tests
// exercise the pure persistence helper directly (no live model, no provider) —
// per the issue's own guidance, this is the cleanest way to verify the
// mechanism without standing up an agent loop.

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

function makeTrialResult(taskId: string, trialIndex: number, passed: boolean): TrialResult {
  const transcript = makeTranscript({
    taskId,
    trialIndex,
    outcome: passed ? "passed" : "failed",
  });
  return {
    taskId,
    trialIndex,
    passed,
    partialScore: passed ? 1 : 0,
    graderResults: [],
    transcript,
    metrics: {
      nTurns: 1,
      nToolCalls: 1,
      nTotalTokens: 10,
      nPromptTokens: 5,
      nCompletionTokens: 5,
      latencyMs: 100,
    },
  };
}

function makeTaskEvalResult(taskId: string, nTrials: number): TaskEvalResult {
  const trials = Array.from({ length: nTrials }, (_, i) =>
    makeTrialResult(taskId, i, i === 0),
  );
  return {
    task: {
      id: taskId,
      desc: `Test task ${taskId}`,
      setup: {},
      graders: [],
      trackedMetrics: [],
    },
    trials,
    passAt1: trials.filter((t) => t.passed).length / trials.length,
    passAtK: {},
    passAllK: 0,
    avgPartialScore: 0,
    avgMetrics: trials[0]!.metrics,
  };
}

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `eval-save-transcripts-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("saveTrialTranscripts", () => {
  it("writes every trial's transcript to <taskId>/<id>.json and it loads back", async () => {
    const store = new TranscriptStore(dir);
    const taskResults: TaskEvalResult[] = [
      makeTaskEvalResult("task-a", 3),
      makeTaskEvalResult("task-b", 2),
    ];

    const count = await saveTrialTranscripts(store, taskResults);
    expect(count).toBe(5);

    // Files land under <dir>/<taskId>/<id>.json
    const taskADirEntries = await readdir(join(dir, "task-a"));
    const taskBDirEntries = await readdir(join(dir, "task-b"));
    expect(taskADirEntries.filter((f) => f.endsWith(".json")).length).toBe(3);
    expect(taskBDirEntries.filter((f) => f.endsWith(".json")).length).toBe(2);

    // Saved files load back as valid Transcripts via the store.
    const loadedA = await store.loadAll("task-a");
    const loadedB = await store.loadAll("task-b");
    expect(loadedA.length).toBe(3);
    expect(loadedB.length).toBe(2);
    for (const t of [...loadedA, ...loadedB]) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.taskId).toBe("string");
      expect(["passed", "failed", "error", "timeout"]).toContain(t.outcome);
    }

    // The exact trials that went in come back out (by id).
    const savedIds = taskResults.flatMap((r) => r.trials.map((t) => t.transcript.id));
    const loadedIds = new Set([...loadedA, ...loadedB].map((t) => t.id));
    for (const id of savedIds) {
      expect(loadedIds.has(id)).toBe(true);
    }
  });

  it("returns 0 and writes nothing for an empty task-results array", async () => {
    const store = new TranscriptStore(dir);
    const count = await saveTrialTranscripts(store, []);
    expect(count).toBe(0);

    // No task subdirectories should have been created.
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      entries = [];
    }
    expect(entries.length).toBe(0);
  });

  it("also accepts a bare TrialResult[] (already-flattened trials)", async () => {
    const store = new TranscriptStore(dir);
    const trials = [
      makeTrialResult("task-c", 0, true),
      makeTrialResult("task-c", 1, false),
    ];

    const count = await saveTrialTranscripts(store, trials);
    expect(count).toBe(2);

    const loaded = await store.loadAll("task-c");
    expect(loaded.length).toBe(2);
  });
});

describe("env.saveTranscripts (SMALLCODE_SAVE_TRANSCRIPTS, default OFF)", () => {
  const original = process.env["SMALLCODE_SAVE_TRANSCRIPTS"];
  afterEach(() => {
    if (original === undefined) delete process.env["SMALLCODE_SAVE_TRANSCRIPTS"];
    else process.env["SMALLCODE_SAVE_TRANSCRIPTS"] = original;
  });

  it("unset -> false (off by default)", () => {
    delete process.env["SMALLCODE_SAVE_TRANSCRIPTS"];
    expect(env.saveTranscripts).toBe(false);
  });

  it('"1" -> true', () => {
    process.env["SMALLCODE_SAVE_TRANSCRIPTS"] = "1";
    expect(env.saveTranscripts).toBe(true);
  });

  it('"0" -> false', () => {
    process.env["SMALLCODE_SAVE_TRANSCRIPTS"] = "0";
    expect(env.saveTranscripts).toBe(false);
  });
});
