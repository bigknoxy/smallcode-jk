import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTurn,
  advanceGoal,
  buildSystemPrompt,
  buildTurnPrompt,
  createState,
  currentGoal,
  failGoal,
  isTerminal,
  loadState,
  planTask,
  runLoop,
  saveState,
} from "../src/agent/index.ts";
import type { AgentConfig, TurnRecord } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
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

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    repoRoot: "/tmp/test-repo",
    modelId: "test-model",
    maxTurns: 10,
    bestOfN: 1,
    ...overrides,
  };
}

function makeProfile(): ModelProfile {
  return {
    id: "test-model",
    label: "Test Model",
    contextWindow: 4096,
    samplingDefaults: {
      temperature: 0.2,
      top_p: 0.9,
      top_k: -1,
      max_tokens: 1024,
    },
    supportsGrammar: false,
    supportsJsonSchema: false,
  };
}

function makeProvider(responseText: string): Provider {
  return {
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
      rawContent: responseText,
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    }),
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: responseText, done: true };
    },
  };
}

function makeContext(): ContextBundle {
  return {
    chunks: [],
    totalTokens: 0,
    tokenBudget: 2048,
    truncated: false,
    query: "test goal",
  };
}

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turn: 1,
    goalId: "goal-1",
    prompt: "test prompt",
    rawResponse: "raw",
    answer: "answer",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 10,
    completionTokens: 20,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test directory setup
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `smallcode-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. createState builds correct initial structure
// ---------------------------------------------------------------------------

describe("createState", () => {
  it("1. builds correct initial structure", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "Implement feature X");

    expect(state.task).toBe("Implement feature X");
    expect(state.repoRoot).toBe(testDir);
    expect(state.modelId).toBe("test-model");
    expect(state.status).toBe("running");
    expect(state.goals).toEqual([]);
    expect(state.turns).toEqual([]);
    expect(state.currentGoalIndex).toBe(0);
    expect(state.scratchpad).toBe("");
    expect(state.maxTurns).toBe(10);
    expect(typeof state.sessionId).toBe("string");
    expect(state.sessionId.length).toBeGreaterThan(0);
    expect(typeof state.startedAt).toBe("number");
    expect(typeof state.updatedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 2. addTurn appends turn and updates updatedAt
// ---------------------------------------------------------------------------

describe("addTurn", () => {
  it("2. appends turn and updates updatedAt", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    const before = state.updatedAt;

    // Small delay to ensure timestamp differs
    const turn = makeTurn();
    addTurn(state, turn);

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toBe(turn);
    expect(state.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 3. advanceGoal moves currentGoalIndex forward, marks goal done
// ---------------------------------------------------------------------------

describe("advanceGoal", () => {
  it("3. moves currentGoalIndex forward and marks goal done", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.goals = [
      { id: "goal-1", description: "first", status: "in_progress" },
      { id: "goal-2", description: "second", status: "pending" },
    ];
    state.currentGoalIndex = 0;

    advanceGoal(state);

    expect(state.currentGoalIndex).toBe(1);
    expect(state.goals[0]?.status).toBe("done");
    expect(state.goals[0]?.completedAt).toBeDefined();
    expect(state.status).toBe("running"); // still has goal-2
  });

  it("3b. marks state done when last goal is advanced", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.goals = [{ id: "goal-1", description: "first", status: "in_progress" }];
    state.currentGoalIndex = 0;

    advanceGoal(state);

    expect(state.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// 4. failGoal marks goal failed with error message
// ---------------------------------------------------------------------------

describe("failGoal", () => {
  it("4. marks current goal failed and sets state to failed", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.goals = [{ id: "goal-1", description: "first", status: "in_progress" }];
    state.currentGoalIndex = 0;

    failGoal(state, "Something went wrong");

    expect(state.goals[0]?.status).toBe("failed");
    expect(state.goals[0]?.error).toBe("Something went wrong");
    expect(state.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// 5. isTerminal returns false for running, true for done/failed/max_turns
// ---------------------------------------------------------------------------

describe("isTerminal", () => {
  it("5a. returns false for running", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    expect(isTerminal(state)).toBe(false);
  });

  it("5b. returns true for done", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.status = "done";
    expect(isTerminal(state)).toBe(true);
  });

  it("5c. returns true for failed", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.status = "failed";
    expect(isTerminal(state)).toBe(true);
  });

  it("5d. returns true for max_turns", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.status = "max_turns";
    expect(isTerminal(state)).toBe(true);
  });

  it("5e. returns true for abandoned", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.status = "abandoned";
    expect(isTerminal(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. currentGoal returns correct goal, null when exhausted
// ---------------------------------------------------------------------------

describe("currentGoal", () => {
  it("6a. returns goal at current index", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.goals = [
      { id: "goal-1", description: "first", status: "pending" },
      { id: "goal-2", description: "second", status: "pending" },
    ];
    state.currentGoalIndex = 0;

    expect(currentGoal(state)?.id).toBe("goal-1");

    state.currentGoalIndex = 1;
    expect(currentGoal(state)?.id).toBe("goal-2");
  });

  it("6b. returns null when index is past goals array", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.goals = [{ id: "goal-1", description: "first", status: "done" }];
    state.currentGoalIndex = 1; // past end

    expect(currentGoal(state)).toBeNull();
  });

  it("6c. returns null when goals array is empty", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");

    expect(currentGoal(state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. saveState + loadState round-trip
// ---------------------------------------------------------------------------

describe("saveState / loadState", () => {
  it("7. round-trips state correctly", async () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "round-trip test");
    state.goals = [{ id: "goal-1", description: "do something", status: "pending" }];
    state.scratchpad = "some notes";

    const statePath = join(testDir, "state.json");
    await saveState(state, statePath);

    const loaded = await loadState(statePath);
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe(state.sessionId);
    expect(loaded?.task).toBe(state.task);
    expect(loaded?.goals).toHaveLength(1);
    expect(loaded?.goals[0]?.id).toBe("goal-1");
    expect(loaded?.scratchpad).toBe("some notes");
    expect(loaded?.status).toBe("running");
  });

  it("7b. returns null for missing file", async () => {
    const statePath = join(testDir, "nonexistent.json");
    const loaded = await loadState(statePath);
    expect(loaded).toBeNull();
  });

  it("7c. returns null for corrupt JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    const statePath = join(testDir, "corrupt.json");
    await writeFile(statePath, "{ not valid json", "utf-8");
    const loaded = await loadState(statePath);
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. buildSystemPrompt contains edit format instructions
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  it("8. contains edit format instructions", () => {
    const profile = makeProfile();
    const config = makeConfig();
    const prompt = buildSystemPrompt(profile, config);

    expect(prompt).toContain("<<<<<<< SEARCH");
    expect(prompt).toContain(">>>>>>> REPLACE");
    expect(prompt).toContain("TOOL: finish");
    expect(prompt).toContain("smallcode");
  });
});

// ---------------------------------------------------------------------------
// 9. buildTurnPrompt contains current goal description
// ---------------------------------------------------------------------------

describe("buildTurnPrompt", () => {
  it("9. contains current goal description", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "my task");
    state.goals = [{ id: "goal-1", description: "Read the config file", status: "in_progress" }];
    state.currentGoalIndex = 0;

    const context = makeContext();
    const prompt = buildTurnPrompt(state, context);

    expect(prompt).toContain("Read the config file");
    expect(prompt).toContain("my task");
  });

  it("9b. includes context chunks when present", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.goals = [{ id: "goal-1", description: "goal", status: "in_progress" }];

    const context: ContextBundle = {
      chunks: [
        {
          filePath: "src/foo.ts",
          startLine: 1,
          endLine: 10,
          content: "const x = 1;",
          estimatedTokens: 5,
        },
      ],
      totalTokens: 5,
      tokenBudget: 2048,
      truncated: false,
      query: "goal",
    };

    const prompt = buildTurnPrompt(state, context);
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("const x = 1;");
  });
});

// ---------------------------------------------------------------------------
// 10. planTask with mock provider → 2 goals parsed
// ---------------------------------------------------------------------------

describe("planTask", () => {
  it("10. parses numbered list from model response", async () => {
    const provider = makeProvider("1. Read foo\n2. Write bar");
    const profile = makeProfile();
    const context = makeContext();

    const goals = await planTask("fix the bug", context, {
      provider,
      modelId: "test-model",
      profile,
      repoRoot: testDir,
    });

    expect(goals).toHaveLength(2);
    expect(goals[0]?.id).toBe("goal-1");
    expect(goals[0]?.description).toBe("Read foo");
    expect(goals[0]?.status).toBe("pending");
    expect(goals[1]?.id).toBe("goal-2");
    expect(goals[1]?.description).toBe("Write bar");
  });
});

// ---------------------------------------------------------------------------
// 11. planTask with garbled model response → 1 fallback goal
// ---------------------------------------------------------------------------

describe("planTask fallback", () => {
  it("11. falls back to single goal on garbled response", async () => {
    const provider = makeProvider("I cannot help with that request at this time.");
    const profile = makeProfile();
    const context = makeContext();

    const goals = await planTask("original task", context, {
      provider,
      modelId: "test-model",
      profile,
      repoRoot: testDir,
    });

    expect(goals).toHaveLength(1);
    expect(goals[0]?.id).toBe("goal-1");
    expect(goals[0]?.description).toBe("original task");
    expect(goals[0]?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 12. runLoop: 1 turn, calls finish, advances goal, saves state
// ---------------------------------------------------------------------------

describe("runLoop", () => {
  it("12. runs 1 turn, calls finish, advances goal, saves state", async () => {
    const config = makeConfig({ repoRoot: testDir, maxTurns: 5 });
    const state = createState(config, "test task");
    state.goals = [{ id: "goal-1", description: "Do the thing", status: "pending" }];

    const finishResponse = 'All done.\nTOOL: finish {"summary": "completed the thing"}';
    const provider = makeProvider(finishResponse);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeContext(),
    );

    expect(finalState.status).toBe("done");
    expect(finalState.turns).toHaveLength(1);
    expect(finalState.goals[0]?.status).toBe("done");
    expect(finalState.currentGoalIndex).toBe(1);

    // Verify state was saved
    const loaded = await loadState(statePath);
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe("done");
  });

  it("12b. records tool calls from response", async () => {
    const config = makeConfig({ repoRoot: testDir, maxTurns: 5 });
    const state = createState(config, "test task");
    state.goals = [{ id: "goal-1", description: "Read a file", status: "pending" }];

    // Response has a read_file call then finish
    const response = 'TOOL: read_file {"path": "src/foo.ts"}\nTOOL: finish {"summary": "read it"}';
    const provider = makeProvider(response);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state2.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeContext(),
    );

    expect(finalState.turns[0]?.toolCalls).toHaveLength(2);
    expect(finalState.turns[0]?.toolCalls[0]?.name).toBe("read_file");
  });
});

// ---------------------------------------------------------------------------
// 13. runLoop hits maxTurns → status "max_turns"
// ---------------------------------------------------------------------------

describe("runLoop maxTurns", () => {
  it("13. sets status to max_turns when turns are exhausted", async () => {
    const config = makeConfig({ repoRoot: testDir, maxTurns: 2 });
    const state = createState(config, "infinite task");
    // Give it a goal that never finishes (no finish tool call in response)
    state.goals = [{ id: "goal-1", description: "Work forever", status: "pending" }];

    const neverFinishResponse = "I am working on it. Thinking deeply.";
    const provider = makeProvider(neverFinishResponse);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state3.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeContext(),
    );

    expect(finalState.status).toBe("max_turns");
    expect(finalState.turns).toHaveLength(2);
  });
});
