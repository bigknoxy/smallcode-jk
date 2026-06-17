import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeterministicGrader } from "@/eval/graders/deterministic.ts";
import { runGrader } from "@/eval/graders/index.ts";
import type { LLMJudgeOptions } from "@/eval/graders/llm.ts";
import { runLLMGrader } from "@/eval/graders/llm.ts";
import { runStaticGrader } from "@/eval/graders/static.ts";
import { loadSuite, loadTask } from "@/eval/task-loader.ts";
import type {
  DeterministicTestsGrader,
  LLMRubricGrader,
  StaticAnalysisGrader,
  Transcript,
} from "@/eval/types.ts";
import type { CompletionRequest, CompletionResponse, StreamChunk } from "@/provider/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory, return path + cleanup fn */
async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(
    tmpdir(),
    `eval-grader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Write a minimal passing Bun test project to dir */
async function setupPassingBunProject(dir: string): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "test-project", module: "index.ts", type: "module", private: true }),
    "utf-8",
  );
  await writeFile(
    join(dir, "passing.test.ts"),
    `import { expect, it } from "bun:test";\nit("passes", () => { expect(1 + 1).toBe(2); });\n`,
    "utf-8",
  );
}

/** Write a minimal failing Bun test project to dir */
async function setupFailingBunProject(dir: string): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "test-project", module: "index.ts", type: "module", private: true }),
    "utf-8",
  );
  await writeFile(
    join(dir, "failing.test.ts"),
    `import { expect, it } from "bun:test";\nit("fails", () => { expect(1).toBe(2); });\n`,
    "utf-8",
  );
}

/** Write a valid TS project (no errors) to dir */
async function setupValidTsProject(dir: string): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "ts-project", type: "module", private: true }),
    "utf-8",
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
    }),
    "utf-8",
  );
  await writeFile(join(dir, "index.ts"), `export const x: number = 42;\n`, "utf-8");
}

/** Minimal Transcript for LLM grader tests */
function makeTranscript(): Transcript {
  return {
    id: "t1",
    sessionId: "s1",
    taskId: "task1",
    trialIndex: 0,
    modelId: "test-model",
    turns: [
      {
        turn: 1,
        goalId: "g1",
        prompt: "Fix the bug",
        rawResponse: "Fixed it",
        answer: "Fixed it",
        toolCalls: [],
        toolResults: [],
        editBlocks: [],
        applyResults: [],
        promptTokens: 10,
        completionTokens: 5,
        timestamp: Date.now(),
      },
    ],
    outcome: "passed",
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
  };
}

/** Mock provider — returns a fixed response string */
function makeMockProvider(responseText: string): LLMJudgeOptions["provider"] {
  return {
    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      return {
        rawContent: responseText,
        model: "mock",
        finishReason: "stop",
      };
    },
    async *stream(_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: responseText, done: false };
      yield { delta: "", done: true };
    },
  };
}

function makeLLMOpts(responseText: string): LLMJudgeOptions {
  return {
    provider: makeMockProvider(responseText),
    modelId: "mock-model",
    profile: {
      id: "mock-model",
      label: "Mock",
      contextWindow: 4096,
      samplingDefaults: {
        temperature: 0,
        top_p: 1,
        top_k: -1,
        max_tokens: 256,
      },
      supportsGrammar: false,
      supportsJsonSchema: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Valid task JSON for re-use
// ---------------------------------------------------------------------------

const validTaskJson = {
  id: "task-001",
  desc: "A test task",
  setup: { files: { "README.md": "hello" } },
  graders: [{ type: "static_analysis", commands: ["tsc"] }],
  trackedMetrics: ["n_turns", "pass_at_1"],
  tags: ["test"],
};

// ---------------------------------------------------------------------------
// 1. loadTask parses valid JSON task file
// ---------------------------------------------------------------------------

describe("loadTask", () => {
  it("parses a valid JSON task file", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const taskPath = join(dir, "task.json");
      await writeFile(taskPath, JSON.stringify(validTaskJson), "utf-8");

      const task = await loadTask(taskPath);
      expect(task.id).toBe("task-001");
      expect(task.desc).toBe("A test task");
      expect(task.trackedMetrics).toEqual(["n_turns", "pass_at_1"]);
      expect(task.graders).toHaveLength(1);
      expect(task.graders[0]?.type).toBe("static_analysis");
    } finally {
      await cleanup();
    }
  });

  // ── 2. loadTask throws on missing required field ───────────────────────────
  it("throws on missing required field (id)", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const invalid = { desc: "no id here", setup: {}, graders: [], trackedMetrics: [] };
      const taskPath = join(dir, "task.json");
      await writeFile(taskPath, JSON.stringify(invalid), "utf-8");

      await expect(loadTask(taskPath)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  // ── 3. loadTask coerces snake_case keys ────────────────────────────────────
  it("coerces snake_case keys (tracked_metrics → trackedMetrics, repo_fixture → repoFixture)", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const snakeCaseTask = {
        id: "task-snake",
        desc: "snake case test",
        setup: { repo_fixture: "my-fixture" },
        graders: [],
        tracked_metrics: ["n_turns"],
        reference_solution: "sol/ref",
      };
      const taskPath = join(dir, "task.json");
      await writeFile(taskPath, JSON.stringify(snakeCaseTask), "utf-8");

      const task = await loadTask(taskPath);
      expect(task.trackedMetrics).toEqual(["n_turns"]);
      expect(task.setup.repoFixture).toBe("my-fixture");
      expect(task.referenceSolution).toBe("sol/ref");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. runDeterministicGrader with passing tests → verdict "pass", score 1.0
// ---------------------------------------------------------------------------

describe("runDeterministicGrader", () => {
  let tempDir: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  it("returns verdict 'pass' and score 1.0 when all required tests pass", async () => {
    await setupPassingBunProject(tempDir.dir);

    const grader: DeterministicTestsGrader = {
      type: "deterministic_tests",
      required: ["passing.test.ts"],
      command: "bun test",
    };

    const result = await runDeterministicGrader(grader, tempDir.dir);
    // Bun exits 0 on pass — so either "pass" or we rely on exit code path
    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(1);
    expect(result.type).toBe("deterministic_tests");
  });

  // ── 5. runDeterministicGrader with failing tests ───────────────────────────
  it("returns verdict 'fail' or 'partial' when tests fail", async () => {
    await setupFailingBunProject(tempDir.dir);

    const grader: DeterministicTestsGrader = {
      type: "deterministic_tests",
      required: ["failing.test.ts"],
      command: "bun test",
    };

    const result = await runDeterministicGrader(grader, tempDir.dir);
    expect(["fail", "partial"]).toContain(result.verdict);
    expect(result.score).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// 6. runStaticGrader with valid TS project → verdict "pass"
// ---------------------------------------------------------------------------

describe("runStaticGrader", () => {
  let tempDir: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  it("returns verdict 'pass' with valid TS project", async () => {
    await setupValidTsProject(tempDir.dir);

    const grader: StaticAnalysisGrader = {
      type: "static_analysis",
      commands: ["tsc"],
    };

    const result = await runStaticGrader(grader, tempDir.dir);
    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(1);
    expect(result.type).toBe("static_analysis");
  }, 30_000);

  // ── 7. runStaticGrader command error → verdict "fail" ─────────────────────
  it("returns verdict 'fail' when a command exits non-zero", async () => {
    // Write a TS file with a type error
    await writeFile(
      join(tempDir.dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
        },
      }),
      "utf-8",
    );
    await writeFile(
      join(tempDir.dir, "broken.ts"),
      `const x: number = "this is a string";\n`,
      "utf-8",
    );

    const grader: StaticAnalysisGrader = {
      type: "static_analysis",
      commands: ["tsc"],
    };

    const result = await runStaticGrader(grader, tempDir.dir);
    expect(result.verdict).toBe("fail");
    expect(result.score).toBeLessThan(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 8. runLLMGrader with mock provider returning "Verdict: PASS\nScore: 1.0"
// ---------------------------------------------------------------------------

describe("runLLMGrader", () => {
  it("returns verdict 'pass' when judge says PASS / Score 1.0", async () => {
    const grader: LLMRubricGrader = {
      type: "llm_rubric",
      rubric: "Does the code solve the task?",
    };
    const opts = makeLLMOpts("Verdict: PASS\nScore: 1.0\nReason: Looks good.");

    const result = await runLLMGrader(grader, makeTranscript(), "/tmp", opts);
    expect(result.verdict).toBe("pass");
    expect(result.score).toBeCloseTo(1.0);
    expect(result.type).toBe("llm_rubric");
  });

  // ── 9. runLLMGrader mock returning "Verdict: UNKNOWN\nScore: 0.5" ─────────
  it("returns verdict 'unknown' when judge says UNKNOWN / Score 0.5", async () => {
    const grader: LLMRubricGrader = {
      type: "llm_rubric",
      rubric: "Is the code idiomatic?",
    };
    const opts = makeLLMOpts("Verdict: UNKNOWN\nScore: 0.5\nReason: Not sure.");

    const result = await runLLMGrader(grader, makeTranscript(), "/tmp", opts);
    expect(result.verdict).toBe("unknown");
    expect(result.score).toBeCloseTo(0.5);
  });

  it("returns verdict 'fail' when judge says FAIL", async () => {
    const grader: LLMRubricGrader = {
      type: "llm_rubric",
      rubric: "Is the solution correct?",
    };
    const opts = makeLLMOpts("Verdict: FAIL\nScore: 0.0\nReason: Wrong output.");

    const result = await runLLMGrader(grader, makeTranscript(), "/tmp", opts);
    expect(result.verdict).toBe("fail");
    expect(result.score).toBeCloseTo(0.0);
  });
});

// ---------------------------------------------------------------------------
// 10. runGrader routes to correct implementation by type
// ---------------------------------------------------------------------------

describe("runGrader dispatcher", () => {
  const transcript = makeTranscript();

  it("routes deterministic_tests to runDeterministicGrader", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      await setupPassingBunProject(dir);
      const grader: DeterministicTestsGrader = {
        type: "deterministic_tests",
        required: [],
        command: "bun test",
      };
      const result = await runGrader(grader, dir, transcript);
      expect(result.type).toBe("deterministic_tests");
    } finally {
      await cleanup();
    }
  });

  it("routes static_analysis to runStaticGrader", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const grader: StaticAnalysisGrader = {
        type: "static_analysis",
        commands: ["bun --version"],
      };
      const result = await runGrader(grader, dir, transcript);
      expect(result.type).toBe("static_analysis");
    } finally {
      await cleanup();
    }
  });

  it("routes llm_rubric to runLLMGrader", async () => {
    const grader: LLMRubricGrader = {
      type: "llm_rubric",
      rubric: "test rubric",
    };
    const opts = makeLLMOpts("Verdict: PASS\nScore: 1.0\nReason: Fine.");
    const result = await runGrader(grader, "/tmp", transcript, opts);
    expect(result.type).toBe("llm_rubric");
  });

  it("throws when llm_rubric requested without llmOpts", async () => {
    const grader: LLMRubricGrader = {
      type: "llm_rubric",
      rubric: "test rubric",
    };
    await expect(runGrader(grader, "/tmp", transcript)).rejects.toThrow("llmOpts");
  });
});

// ---------------------------------------------------------------------------
// 11. loadSuite reads directory of task files
// ---------------------------------------------------------------------------

describe("loadSuite", () => {
  it("reads a directory of task files", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      // Write two task files
      const task1 = { ...validTaskJson, id: "task-a" };
      const task2 = { ...validTaskJson, id: "task-b" };
      await writeFile(join(dir, "task-a.json"), JSON.stringify(task1), "utf-8");
      await writeFile(join(dir, "task-b.json"), JSON.stringify(task2), "utf-8");

      const suite = await loadSuite(dir);
      expect(suite.tasks).toHaveLength(2);
      const ids = suite.tasks.map((t) => t.id).sort();
      expect(ids).toEqual(["task-a", "task-b"]);
    } finally {
      await cleanup();
    }
  });

  it("reads suite.json manifest when present", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const manifest = {
        id: "my-suite",
        kind: "regression",
        description: "Regression suite",
        defaultTrials: 3,
      };
      await writeFile(join(dir, "suite.json"), JSON.stringify(manifest), "utf-8");
      await writeFile(join(dir, "task-x.json"), JSON.stringify(validTaskJson), "utf-8");

      const suite = await loadSuite(dir);
      expect(suite.id).toBe("my-suite");
      expect(suite.kind).toBe("regression");
      expect(suite.description).toBe("Regression suite");
      expect(suite.defaultTrials).toBe(3);
      expect(suite.tasks).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
