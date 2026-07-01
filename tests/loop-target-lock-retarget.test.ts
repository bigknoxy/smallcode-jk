import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, runLoop } from "../src/agent/index.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// ---------------------------------------------------------------------------
// Target-lock RETARGET (mis-pin self-correction, dogfood follow-up).
//
// The hard target-lock (loop-target-lock.test.ts / tests/target-lock.test.ts)
// rejects every edit to a file other than the pinned target for the whole
// run. That's correct when the model is drifting off-task — but when
// RETRIEVAL itself mis-pins the wrong file, the lock permanently blocks the
// file that could actually fix the bug, and the task is unsolvable no matter
// what the model tries (dogfood: `effectiveContextWindow` lives in
// context-budget.ts, but retrieval pinned types.ts — which merely DEFINES the
// fields the query mentioned — and the model's real fix was rejected all 4
// turns to max_turns).
//
// Fix: when the model's edit to a NON-locked path is rejected, track
// consecutive rejections on that SAME path. Two consecutive attempts at the
// SAME off-target SOURCE file (never a test file) retargets the lock to it
// instead of rejecting a third time — the mis-pin self-corrects within one
// extra turn. A DIFFERENT off-target file each turn (genuine drift) never
// builds a streak and keeps getting rejected forever, same as before.
// ---------------------------------------------------------------------------

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

function makeSequentialProvider(responses: string[]): Provider {
  let call = 0;
  return {
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => {
      const text = responses[Math.min(call, responses.length - 1)] ?? "";
      call++;
      return {
        rawContent: text,
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      };
    },
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "", done: true };
    },
  };
}

// The retrieval-pinned (WRONG) target. Edits to it never fix the failing
// test, so the loop keeps running for every configured turn.
const PINNED_PATH = "src/types.ts";
// The REAL fix target the model keeps trying instead.
const TRUE_TARGET = "src/context-budget.ts";

function makePinnedContext(): ContextBundle {
  return {
    chunks: [
      {
        filePath: PINNED_PATH,
        startLine: 1,
        endLine: 1,
        content: "export const contextWindow = 4096;\n",
        estimatedTokens: 10,
        pinned: true,
      },
    ],
    totalTokens: 10,
    tokenBudget: 4096,
    truncated: false,
    query: "fix effectiveContextWindow",
    targetFile: { path: PINNED_PATH, lineCount: 1, format: "full" },
  };
}

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `smallcode-retarget-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
  await writeFile(join(testDir, "src", "types.ts"), "export const contextWindow = 4096;\n", "utf-8");
  await writeFile(
    join(testDir, "src", "context-budget.ts"),
    "export function effectiveContextWindow() {\n  return 0;\n}\n",
    "utf-8",
  );
  await writeFile(
    join(testDir, "tests", "context-budget.test.ts"),
    'import { test, expect } from "bun:test";\nimport { effectiveContextWindow } from "../src/context-budget.ts";\ntest("computes window", () => expect(effectiveContextWindow()).toBe(4096));\n',
    "utf-8",
  );
});

afterEach(async () => {
  delete process.env["SMALLCODE_TARGET_LOCK"];
  await rm(testDir, { recursive: true, force: true });
});

describe("target-lock retarget — persistent same-file mis-pin", () => {
  it("retargets to the file the model persistently edits after 2 consecutive rejections", async () => {
    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 3, bestOfN: 1 };
    const state = createState(config, "Fix effectiveContextWindow in src/context-budget.ts");
    state.goals = [{ id: "goal-1", description: "Fix effectiveContextWindow", status: "pending" }];

    const responses = [
      // Turn 1: edits the (wrongly) pinned target — this ESTABLISHES the lock
      // on PINNED_PATH. Doesn't fix the test, so the loop keeps running.
      `TOOL: write_file {"path": "${PINNED_PATH}", "content": "export const contextWindow = 8192;\\n"}`,
      // Turn 2: the model correctly tries the REAL target instead. 1st
      // consecutive off-target attempt — still rejected.
      `TOOL: write_file {"path": "${TRUE_TARGET}", "content": "export function effectiveContextWindow() {\\n  return 4096;\\n}\\n"}`,
      // Turn 3: tries the SAME real target again. 2nd consecutive attempt at
      // the same off-target path — crosses the retarget threshold.
      `TOOL: write_file {"path": "${TRUE_TARGET}", "content": "export function effectiveContextWindow() {\\n  return 4096;\\n}\\n"}\nTOOL: finish {"summary": "fixed"}`,
    ];
    const provider = makeSequentialProvider(responses);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makePinnedContext(),
    );

    // Turn 1: lock established on the (wrong) pinned path.
    expect(finalState.turns[0]!.toolResults.find((r) => r.name === "write_file")?.success).toBe(true);

    // Turn 2: 1st attempt at the real target — REJECTED, not written.
    const turn2 = finalState.turns[1]!.toolResults.find((r) => r.name === "write_file");
    expect(turn2?.success).toBe(false);
    expect(turn2?.error).toContain("REJECTED");
    expect(turn2?.error).toContain(TRUE_TARGET);

    // Turn 3: 2nd consecutive attempt at the SAME real target — the lock
    // RETARGETS and the edit APPLIES.
    const turn3 = finalState.turns[2]!.toolResults.find((r) => r.name === "write_file");
    expect(turn3?.success).toBe(true);

    // The lock followed the model to the real target.
    expect(finalState.lockedTargetPath).toBe(TRUE_TARGET);

    const onDisk = await Bun.file(join(testDir, "src", "context-budget.ts")).text();
    expect(onDisk).toContain("return 4096;");

    // The oracle went green once the real fix landed.
    expect(finalState.verified).toBe(true);
    expect(finalState.status).toBe("done");
  });

  it("does NOT retarget on random drift — a DIFFERENT off-target file each turn stays rejected", async () => {
    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 3, bestOfN: 1 };
    const state = createState(config, "Fix effectiveContextWindow in src/context-budget.ts");
    state.goals = [{ id: "goal-1", description: "Fix effectiveContextWindow", status: "pending" }];

    const responses = [
      `TOOL: write_file {"path": "${PINNED_PATH}", "content": "export const contextWindow = 8192;\\n"}`,
      // Turn 2: wanders to file B.
      `TOOL: write_file {"path": "src/b.ts", "content": "export const b = 1;\\n"}`,
      // Turn 3: wanders to file C (DIFFERENT from B) — streak never builds.
      `TOOL: write_file {"path": "src/c.ts", "content": "export const c = 1;\\n"}`,
    ];
    const provider = makeSequentialProvider(responses);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makePinnedContext(),
    );

    const turn2 = finalState.turns[1]!.toolResults.find((r) => r.name === "write_file");
    expect(turn2?.success).toBe(false);
    const turn3 = finalState.turns[2]!.toolResults.find((r) => r.name === "write_file");
    expect(turn3?.success).toBe(false);

    // The lock never moved off the originally-pinned (wrong) path.
    expect(finalState.lockedTargetPath).toBe(PINNED_PATH);

    expect(await Bun.file(join(testDir, "src", "b.ts")).exists()).toBe(false);
    expect(await Bun.file(join(testDir, "src", "c.ts")).exists()).toBe(false);
  });

  it("never retargets to a test file, even after repeated attempts", async () => {
    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 3, bestOfN: 1 };
    const state = createState(config, "Fix effectiveContextWindow in src/context-budget.ts");
    state.goals = [{ id: "goal-1", description: "Fix effectiveContextWindow", status: "pending" }];

    const testPath = "tests/context-budget.test.ts";
    const responses = [
      `TOOL: write_file {"path": "${PINNED_PATH}", "content": "export const contextWindow = 8192;\\n"}`,
      // Turn 2 & 3: repeatedly attacks the TEST file (anti-fake-green target)
      // instead of the real source — must NEVER become the retarget, no
      // matter how many consecutive attempts.
      `TOOL: write_file {"path": "${testPath}", "content": "test(\\"stub\\", () => {});\\n"}`,
      `TOOL: write_file {"path": "${testPath}", "content": "test(\\"stub2\\", () => {});\\n"}`,
    ];
    const provider = makeSequentialProvider(responses);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makePinnedContext(),
    );

    for (const turn of [finalState.turns[1]!, finalState.turns[2]!]) {
      const result = turn.toolResults.find((r) => r.name === "write_file");
      expect(result?.success).toBe(false);
    }

    // The lock stayed on the originally-pinned path — never moved to the test.
    expect(finalState.lockedTargetPath).toBe(PINNED_PATH);
    expect(finalState.lockedTargetPath).not.toBe(testPath);
  });
});
