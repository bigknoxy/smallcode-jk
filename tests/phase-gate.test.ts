import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePhase, EXPLORE_REJECT_MESSAGE, PHASE_ALLOWED_TOOLS } from "../src/agent/phase-gate.ts";
import { buildTurnPrompt, createState, runLoop } from "../src/agent/index.ts";
import type { AgentConfig, TurnRecord } from "../src/agent/types.ts";
import type { ContextBundle, TargetFile } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// ---------------------------------------------------------------------------
// Helpers (mirrors tests/agent-loop.test.ts harness)
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
    samplingDefaults: { temperature: 0.2, top_p: 0.9, top_k: -1, max_tokens: 1024 },
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

function makeContext(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    chunks: [],
    totalTokens: 0,
    tokenBudget: 2048,
    truncated: false,
    query: "test goal",
    ...overrides,
  };
}

function makeTargetFile(overrides: Partial<TargetFile> = {}): TargetFile {
  return {
    path: "foo.ts",
    lineCount: 10,
    format: "full",
    ...overrides,
  };
}

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `smallcode-phasegate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  delete process.env["SMALLCODE_PHASE_GATE"];
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// derivePhase — pure unit tests
// ---------------------------------------------------------------------------

describe("derivePhase", () => {
  it("pinned target (context.targetFile) -> edit", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    const context = makeContext({ targetFile: makeTargetFile() });
    expect(derivePhase(state, context)).toBe("edit");
  });

  it("locked target (state.lockedTargetPath) -> edit, even with no live targetFile", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.lockedTargetPath = "bar.ts";
    const context = makeContext();
    expect(derivePhase(state, context)).toBe("edit");
  });

  it("no target, no lock, no prior edit/read -> explore", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    const context = makeContext();
    expect(derivePhase(state, context)).toBe("explore");
  });

  it("no target but a prior turn successfully read a file -> edit", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    const readTurn: TurnRecord = {
      turn: 1,
      goalId: "goal-1",
      prompt: "p",
      rawResponse: "r",
      answer: "a",
      toolCalls: [{ name: "read_file", args: { path: "foo.ts" } }],
      toolResults: [{ name: "read_file", success: true, output: "content" }],
      editBlocks: [],
      applyResults: [],
      promptTokens: 1,
      completionTokens: 1,
      timestamp: Date.now(),
    };
    state.turns = [readTurn];
    const context = makeContext();
    expect(derivePhase(state, context)).toBe("edit");
  });

  it("a FAILED read_file attempt alone does not move the phase to edit", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    const failedReadTurn: TurnRecord = {
      turn: 1,
      goalId: "goal-1",
      prompt: "p",
      rawResponse: "r",
      answer: "a",
      toolCalls: [{ name: "read_file", args: { path: "foo.ts" } }],
      toolResults: [{ name: "read_file", success: false, output: "", error: "boom" }],
      editBlocks: [],
      applyResults: [],
      promptTokens: 1,
      completionTokens: 1,
      timestamp: Date.now(),
    };
    state.turns = [failedReadTurn];
    const context = makeContext();
    expect(derivePhase(state, context)).toBe("explore");
  });

  it("solved/absent-baseline run with no target still resolves to explore (sane default)", () => {
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.status = "done";
    state.verified = true;
    const context = makeContext();
    expect(derivePhase(state, context)).toBe("explore");
  });
});

// ---------------------------------------------------------------------------
// PHASE_ALLOWED_TOOLS
// ---------------------------------------------------------------------------

describe("PHASE_ALLOWED_TOOLS", () => {
  it("explore excludes write_file and run_command", () => {
    expect(PHASE_ALLOWED_TOOLS.explore).not.toContain("write_file");
    expect(PHASE_ALLOWED_TOOLS.explore).not.toContain("run_command");
    expect(PHASE_ALLOWED_TOOLS.explore).toContain("read_file");
    expect(PHASE_ALLOWED_TOOLS.explore).toContain("run_tests");
    expect(PHASE_ALLOWED_TOOLS.explore).toContain("think");
    expect(PHASE_ALLOWED_TOOLS.explore).toContain("finish");
  });

  it("edit includes write_file and run_command (full set, current behavior)", () => {
    expect(PHASE_ALLOWED_TOOLS.edit).toContain("write_file");
    expect(PHASE_ALLOWED_TOOLS.edit).toContain("run_command");
    expect(PHASE_ALLOWED_TOOLS.edit).toContain("read_file");
    expect(PHASE_ALLOWED_TOOLS.edit).toContain("run_tests");
    expect(PHASE_ALLOWED_TOOLS.edit).toContain("think");
    expect(PHASE_ALLOWED_TOOLS.edit).toContain("finish");
  });
});

// ---------------------------------------------------------------------------
// buildTurnPrompt — prompt-level phase gating
// ---------------------------------------------------------------------------

describe("buildTurnPrompt phase gating", () => {
  it("flag OFF: no phase banner, no tool restriction language, Edit Target still shown when a target is pinned", () => {
    delete process.env["SMALLCODE_PHASE_GATE"];
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.goals = [{ id: "goal-1", description: "goal", status: "in_progress" }];
    const context = makeContext();
    const prompt = buildTurnPrompt(state, context);
    expect(prompt).not.toContain("Tools available this turn");
    expect(prompt).not.toContain(EXPLORE_REJECT_MESSAGE);
  });

  it("flag ON + no target: advertises explore tool set and suppresses Edit Target", () => {
    process.env["SMALLCODE_PHASE_GATE"] = "1";
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.goals = [{ id: "goal-1", description: "goal", status: "in_progress" }];
    const context = makeContext();
    const prompt = buildTurnPrompt(state, context);
    expect(prompt).toContain("Tools available this turn (explore phase)");
    const toolsLine = prompt.split("\n").find((l) => l.startsWith("## Tools available this turn"));
    expect(toolsLine).not.toContain("write_file");
    expect(prompt).not.toContain("## Edit Target");
  });

  it("flag ON + pinned target: full tool set advertised, Edit Target still shown (never explore)", () => {
    process.env["SMALLCODE_PHASE_GATE"] = "1";
    const config = makeConfig({ repoRoot: testDir });
    const state = createState(config, "task");
    state.goals = [{ id: "goal-1", description: "goal", status: "in_progress" }];
    const context = makeContext({ targetFile: makeTargetFile() });
    const prompt = buildTurnPrompt(state, context);
    expect(prompt).toContain("Tools available this turn (edit phase)");
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("## Edit Target");
  });
});

// ---------------------------------------------------------------------------
// runLoop — loop-level enforcement
// ---------------------------------------------------------------------------

describe("runLoop phase gate enforcement", () => {
  it("flag ON + no pinned target: a FILE: edit block in turn 1 is REJECTED, nothing written", async () => {
    process.env["SMALLCODE_PHASE_GATE"] = "1";
    const config = makeConfig({ repoRoot: testDir, maxTurns: 2 });
    const state = createState(config, "test task");
    state.goals = [{ id: "goal-1", description: "Add a const", status: "pending" }];

    const response = 'FILE: foo.ts\n```ts\nexport const x = 1;\n```\nTOOL: finish {"summary": "done"}';
    const provider = makeProvider(response);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeContext(),
    );

    const turn1 = finalState.turns[0]!;
    expect(turn1.applyResults).toHaveLength(0);
    expect(turn1.toolResults.some((tr) => tr.error === EXPLORE_REJECT_MESSAGE)).toBe(true);

    const written = await Bun.file(join(testDir, "foo.ts")).exists();
    expect(written).toBe(false);
  });

  it("flag ON + no pinned target: a write_file TOOL call in turn 1 is REJECTED, nothing written", async () => {
    process.env["SMALLCODE_PHASE_GATE"] = "1";
    const config = makeConfig({ repoRoot: testDir, maxTurns: 2 });
    const state = createState(config, "test task");
    state.goals = [{ id: "goal-1", description: "Write a file", status: "pending" }];

    const response =
      'TOOL: write_file {"path": "bar.ts", "content": "export const y = 2;"}\nTOOL: finish {"summary": "done"}';
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

    const turn1 = finalState.turns[0]!;
    expect(turn1.toolResults.some((tr) => tr.name === "write_file" && tr.error === EXPLORE_REJECT_MESSAGE)).toBe(
      true,
    );

    const written = await Bun.file(join(testDir, "bar.ts")).exists();
    expect(written).toBe(false);
  });

  it("flag OFF (default): the SAME FILE: edit block is applied unchanged — no rejection", async () => {
    delete process.env["SMALLCODE_PHASE_GATE"];
    const config = makeConfig({ repoRoot: testDir, maxTurns: 2 });
    const state = createState(config, "test task");
    state.goals = [{ id: "goal-1", description: "Add a const", status: "pending" }];

    const response = 'FILE: foo.ts\n```ts\nexport const x = 1;\n```\nTOOL: finish {"summary": "done"}';
    const provider = makeProvider(response);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state3.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeContext(),
    );

    const turn1 = finalState.turns[0]!;
    expect(turn1.toolResults.some((tr) => tr.error === EXPLORE_REJECT_MESSAGE)).toBe(false);
    expect(turn1.applyResults.some((r) => r.status === "applied")).toBe(true);

    const written = await Bun.file(join(testDir, "foo.ts")).exists();
    expect(written).toBe(true);
  });

  it("flag ON + pinned target from turn 1: edit is applied normally, never gated into explore", async () => {
    process.env["SMALLCODE_PHASE_GATE"] = "1";
    const config = makeConfig({ repoRoot: testDir, maxTurns: 2 });
    const state = createState(config, "test task");
    state.goals = [{ id: "goal-1", description: "Add a const", status: "pending" }];

    const response = 'FILE: foo.ts\n```ts\nexport const x = 1;\n```\nTOOL: finish {"summary": "done"}';
    const provider = makeProvider(response);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state4.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeContext({ targetFile: makeTargetFile({ path: "foo.ts" }) }),
    );

    const turn1 = finalState.turns[0]!;
    expect(turn1.toolResults.some((tr) => tr.error === EXPLORE_REJECT_MESSAGE)).toBe(false);
    expect(turn1.applyResults.some((r) => r.status === "applied")).toBe(true);

    const written = await Bun.file(join(testDir, "foo.ts")).exists();
    expect(written).toBe(true);
  });
});
