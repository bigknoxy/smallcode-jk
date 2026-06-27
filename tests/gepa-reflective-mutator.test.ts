import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { defaultPromptSet } from "../src/agent/prompt-set.ts";
import type { Transcript, TaskEvalResult, EvalTask } from "../src/eval/types.ts";
import type { TaskRunnerOptions } from "../src/eval/task-runner.ts";
import {
  LLMReflectiveMutator,
  buildReflectionPrompt,
  extractDelimitedBlock,
  NEW_SYSTEM_OPEN,
  NEW_SYSTEM_CLOSE,
} from "../src/improve/gepa/reflective-mutator.ts";
import type { FailedInstance, Candidate } from "../src/improve/gepa/types.ts";
import { runGepa } from "../src/improve/gepa/engine.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFailure(taskId: string, rawResponse: string): FailedInstance {
  const transcript: Transcript = {
    id: randomUUID(),
    sessionId: randomUUID(),
    taskId,
    trialIndex: 0,
    modelId: "test-model",
    turns: [
      {
        turn: 0,
        goalId: "g0",
        prompt: "fix the bug",
        rawResponse,
        answer: "",
        toolCalls: [],
        toolResults: [],
        editBlocks: [],
        applyResults: [],
        promptTokens: 0,
        completionTokens: 0,
        timestamp: Date.now(),
      },
    ],
    outcome: "failed",
    startedAt: 0,
    finishedAt: 1,
  };
  return { taskId, transcript };
}

/** A valid rewritten system prompt is well over the 200-char floor. */
const GOOD_SYSTEM = `You are smallcode, a coding assistant. Edit files to complete coding tasks.
Always emit a FILE: or PATCH: edit block immediately, then call TOOL: run_tests {} and
TOOL: finish {"summary": "..."}. Never describe what you will do — just emit the edit.
Preserve all unrelated code exactly as shown in the context.`;

function goodOutput(system = GOOD_SYSTEM): string {
  return `Diagnosis: the model emitted prose instead of an edit block.\n${NEW_SYSTEM_OPEN}\n${system}\n${NEW_SYSTEM_CLOSE}\ndone.`;
}

// ---------------------------------------------------------------------------
// extractDelimitedBlock
// ---------------------------------------------------------------------------

describe("extractDelimitedBlock", () => {
  test("extracts and trims block content", () => {
    const out = extractDelimitedBlock("a <X>\n  hi  \n</X> b", "<X>", "</X>");
    expect(out).toBe("hi");
  });

  test("returns null when open missing", () => {
    expect(extractDelimitedBlock("no markers", "<X>", "</X>")).toBeNull();
  });

  test("returns null when close missing", () => {
    expect(extractDelimitedBlock("<X> dangling", "<X>", "</X>")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildReflectionPrompt
// ---------------------------------------------------------------------------

describe("buildReflectionPrompt", () => {
  test("includes the parent system text + failed task id + rawResponse digest", () => {
    const parent = defaultPromptSet();
    const failures = [makeFailure("edit-rel-foo_1", "I think I should probably edit the file...")];
    const prompt = buildReflectionPrompt(parent, failures);

    // parent system verbatim
    expect(prompt).toContain(parent.system);
    // failed task id
    expect(prompt).toContain("edit-rel-foo_1");
    // rawResponse digest
    expect(prompt).toContain("I think I should probably edit the file...");
    // outcome + tool-call signal
    expect(prompt).toContain("outcome: failed");
    expect(prompt).toContain("tool calls emitted in run: NO");
    // delimiter instruction present
    expect(prompt).toContain(NEW_SYSTEM_OPEN);
    expect(prompt).toContain(NEW_SYSTEM_CLOSE);
  });

  test("caps number of failures shown and notes the total", () => {
    const parent = defaultPromptSet();
    const failures = Array.from({ length: 7 }, (_, i) => makeFailure(`task_${i}`, `resp ${i}`));
    const prompt = buildReflectionPrompt(parent, failures, { maxFailuresShown: 2 });
    expect(prompt).toContain("task_0");
    expect(prompt).toContain("task_1");
    expect(prompt).not.toContain("task_6");
    expect(prompt).toContain("(2 shown of 7)");
  });

  test("truncates an over-long rawResponse", () => {
    const parent = defaultPromptSet();
    const long = "x".repeat(5000);
    const prompt = buildReflectionPrompt(parent, [makeFailure("t", long)], { rawResponseCap: 100 });
    expect(prompt).toContain("[truncated");
    expect(prompt).not.toContain("x".repeat(200));
  });

  test("flags when a tool call WAS emitted", () => {
    const parent = defaultPromptSet();
    const f = makeFailure("t", "ok");
    f.transcript.turns[0]!.toolCalls = [{ name: "run_tests", args: {} } as never];
    const prompt = buildReflectionPrompt(parent, [f]);
    expect(prompt).toContain("tool calls emitted in run: yes");
  });
});

// ---------------------------------------------------------------------------
// LLMReflectiveMutator.mutate — happy path
// ---------------------------------------------------------------------------

describe("LLMReflectiveMutator.mutate", () => {
  test("returns parsed new system; planner/reflection unchanged", async () => {
    const parent = defaultPromptSet();
    const mutator = new LLMReflectiveMutator({
      complete: async () => goodOutput(),
    });
    const result = await mutator.mutate(parent, [makeFailure("t", "prose")]);

    expect(result.system).toBe(GOOD_SYSTEM);
    expect(result.system).not.toBe(parent.system);
    // planner + reflection preserved
    expect(result.planner).toBe(parent.planner);
    expect(result.reflection).toBe(parent.reflection);
  });

  test("passes the built reflection prompt to complete()", async () => {
    const parent = defaultPromptSet();
    let seen = "";
    const mutator = new LLMReflectiveMutator({
      complete: async (p) => {
        seen = p;
        return goodOutput();
      },
    });
    await mutator.mutate(parent, [makeFailure("edit-rel-zzz_1", "blah")]);
    expect(seen).toContain(parent.system);
    expect(seen).toContain("edit-rel-zzz_1");
  });

  test("mutatePlanner rewrites planner when a <NEW_PLANNER> block is present", async () => {
    const parent = defaultPromptSet();
    const newPlanner = "Plan tasks as 1-3 concrete action goals. Output only a numbered list.";
    const mutator = new LLMReflectiveMutator({
      mutatePlanner: true,
      complete: async () =>
        `${NEW_SYSTEM_OPEN}\n${GOOD_SYSTEM}\n${NEW_SYSTEM_CLOSE}\n<NEW_PLANNER>\n${newPlanner}\n</NEW_PLANNER>`,
    });
    const result = await mutator.mutate(parent, [makeFailure("t", "x")]);
    expect(result.system).toBe(GOOD_SYSTEM);
    expect(result.planner).toBe(newPlanner);
  });

  test("mutatePlanner keeps parent planner when no <NEW_PLANNER> block", async () => {
    const parent = defaultPromptSet();
    const mutator = new LLMReflectiveMutator({
      mutatePlanner: true,
      complete: async () => goodOutput(),
    });
    const result = await mutator.mutate(parent, [makeFailure("t", "x")]);
    expect(result.planner).toBe(parent.planner);
  });
});

// ---------------------------------------------------------------------------
// Robustness — every failure mode returns parent UNCHANGED
// ---------------------------------------------------------------------------

describe("LLMReflectiveMutator robustness (no-op on failure)", () => {
  test("malformed output (no block) -> parent unchanged", async () => {
    const parent = defaultPromptSet();
    const mutator = new LLMReflectiveMutator({
      complete: async () => "I have no idea, here is some prose without markers.",
    });
    const result = await mutator.mutate(parent, [makeFailure("t", "x")]);
    expect(result).toEqual(parent);
  });

  test("thrown error -> parent unchanged", async () => {
    const parent = defaultPromptSet();
    const mutator = new LLMReflectiveMutator({
      complete: async () => {
        throw new Error("network down");
      },
    });
    const result = await mutator.mutate(parent, [makeFailure("t", "x")]);
    expect(result).toEqual(parent);
  });

  test("too-short parsed system -> parent unchanged", async () => {
    const parent = defaultPromptSet();
    const mutator = new LLMReflectiveMutator({
      complete: async () => `${NEW_SYSTEM_OPEN}\ntoo short\n${NEW_SYSTEM_CLOSE}`,
    });
    const result = await mutator.mutate(parent, [makeFailure("t", "x")]);
    expect(result).toEqual(parent);
  });

  test("empty block -> parent unchanged", async () => {
    const parent = defaultPromptSet();
    const mutator = new LLMReflectiveMutator({
      complete: async () => `${NEW_SYSTEM_OPEN}\n\n${NEW_SYSTEM_CLOSE}`,
    });
    const result = await mutator.mutate(parent, [makeFailure("t", "x")]);
    expect(result).toEqual(parent);
  });
});

// ---------------------------------------------------------------------------
// Engine-level: runGepa completes a generation with the LIVE mutator class
// (fake complete + stubbed runTask) — no GPU.
// ---------------------------------------------------------------------------

describe("runGepa with LLMReflectiveMutator (no GPU)", () => {
  test("completes a generation end-to-end with the live mutator class", async () => {
    const tasks: EvalTask[] = [
      {
        id: "t-pass",
        desc: "passes",
        setup: {},
        graders: [],
        trackedMetrics: ["pass_at_1"],
      },
      {
        id: "t-fail",
        desc: "fails",
        setup: {},
        graders: [],
        trackedMetrics: ["pass_at_1"],
      },
    ];
    const taskIds = tasks.map((t) => t.id);

    // Stub runTask: t-pass always 1.0, t-fail always 0.0 (so failure path runs).
    const stubRun = async (task: EvalTask, _opts: TaskRunnerOptions): Promise<TaskEvalResult> => {
      const passAt1 = task.id === "t-pass" ? 1 : 0;
      const transcript: Transcript = {
        id: randomUUID(),
        sessionId: randomUUID(),
        taskId: task.id,
        trialIndex: 0,
        modelId: "stub",
        turns: [
          {
            turn: 0,
            goalId: "g0",
            prompt: "p",
            rawResponse: passAt1 ? "FILE: fixed" : "prose, no edit",
            answer: "",
            toolCalls: [],
            toolResults: [],
            editBlocks: [],
            applyResults: [],
            promptTokens: 0,
            completionTokens: 0,
            timestamp: Date.now(),
          },
        ],
        outcome: passAt1 ? "passed" : "failed",
        startedAt: 0,
        finishedAt: 1,
      };
      return {
        task,
        trials: [
          {
            taskId: task.id,
            trialIndex: 0,
            passed: passAt1 === 1,
            partialScore: passAt1,
            graderResults: [],
            transcript,
            metrics: {
              nTurns: 1,
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
          nTurns: 1,
          nToolCalls: 0,
          nTotalTokens: 0,
          nPromptTokens: 0,
          nCompletionTokens: 0,
          latencyMs: 0,
        },
        n: 1,
      };
    };

    let completeCalls = 0;
    let sawFailureDigest = false;
    const mutator = new LLMReflectiveMutator({
      complete: async (prompt) => {
        completeCalls++;
        if (prompt.includes("t-fail")) sawFailureDigest = true;
        return goodOutput();
      },
    });

    const seed: Candidate = {
      id: randomUUID(),
      prompts: defaultPromptSet(),
      parentId: null,
      generation: 0,
      // Seed already reflects the stub scores so the engine picks failed tasks.
      scores: { "t-pass": 1, "t-fail": 0 },
      meanScore: 0.5,
    };

    const evalDeps = {
      baseAgentConfig: {
        repoRoot: "/tmp",
        modelId: "stub",
        maxTurns: 1,
        bestOfN: 1,
      },
      // loopDeps is never used by stubRun.
      loopDeps: undefined as never,
      tasks,
      fixturesRoot: "/tmp",
      runTaskFn: stubRun,
    };

    const front = await runGepa(seed, mutator, evalDeps, {
      taskIds,
      populationCap: 6,
      maxGenerations: 1,
      trialsPerTask: 1,
    });

    // The live mutator was invoked, fed the failing transcript, and the engine
    // produced a scored candidate added to the front.
    expect(completeCalls).toBeGreaterThanOrEqual(1);
    expect(sawFailureDigest).toBe(true);
    expect(front.length).toBeGreaterThanOrEqual(1);
    // A gen-1 candidate exists carrying the mutated system prompt.
    const child = front.find((c) => c.generation === 1);
    expect(child).toBeDefined();
    expect(child!.prompts.system).toBe(GOOD_SYSTEM);
    expect(child!.scores["t-pass"]).toBe(1);
  });
});
