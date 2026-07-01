import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, runLoop } from "../src/agent/index.ts";
import { turnEditedPaths } from "../src/agent/prompt.ts";
import type { AgentConfig, TurnRecord } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// ---------------------------------------------------------------------------
// Off-task-drift regression (dogfood #1 blocker, found via 2 live 7b runs).
//
// The task: fix a bug in one file so a specific failing test passes. Turn 1
// lands a WRONG edit on the correct target file. From there the model would
// previously WANDER — editing unrelated files turn after turn — because
// `TOOL: finish` unconditionally advanced `state.currentGoalIndex` even though
// the oracle still reported the target's test failing (loop.ts's old
// `if (hasFinish) { advanceGoal(state); ... }`). Advancing swapped the
// prompt's "## Current Action" and the retrieval query onto the planner's
// OWN later sub-goals ("write tests" / "run tests"), which have nothing to do
// with the fix file and is exactly how the model free-associated into
// unrelated modules in the live dogfood run.
//
// Fix: while the harness has confidently pinned a single edit target
// (`context.targetFile`) AND the oracle still reports that target's test
// failing, `finish()` no longer advances the goal (loop.ts `anchorActive`
// guard) and the per-turn prompt explicitly re-asserts "Edit ONLY <target>"
// every turn, escalating to a named warning if the PRIOR turn edited some
// other file (prompt.ts "## STAY ON TARGET" section).
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

/** Returns a different response on each successive call, cycling through `responses`. */
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

const TARGET_PATH = "src/calc.ts";
const BUGGY_SOURCE = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
const STILL_WRONG_SOURCE = "export function add(a: number, b: number): number {\n  return a * b;\n}\n";

function makeTargetContext(): ContextBundle {
  return {
    chunks: [
      {
        filePath: TARGET_PATH,
        startLine: 1,
        endLine: 3,
        content: BUGGY_SOURCE,
        estimatedTokens: 20,
        pinned: true,
      },
    ],
    totalTokens: 20,
    tokenBudget: 4096,
    truncated: false,
    query: "fix add in src/calc.ts",
    // A confident single edit target — the signal the anchor guard keys off.
    targetFile: { path: TARGET_PATH, lineCount: 3, format: "full" },
  };
}

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `smallcode-drift-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
  await writeFile(join(testDir, "src", TARGET_PATH.split("/")[1]!), BUGGY_SOURCE, "utf-8");
  await writeFile(
    join(testDir, "tests", "calc.test.ts"),
    'import { test, expect } from "bun:test";\nimport { add } from "../src/calc.ts";\ntest("adds two numbers", () => expect(add(2, 3)).toBe(5));\n',
    "utf-8",
  );
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("off-task-drift guard", () => {
  it("keeps the loop anchored to the target file and re-anchors the prompt instead of wandering", async () => {
    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 3, bestOfN: 1 };
    const state = createState(config, "Fix add() in src/calc.ts so the failing test passes");
    state.goals = [
      { id: "goal-1", description: "Fix add in src/calc.ts", status: "pending" },
      { id: "goal-2", description: "Write tests", status: "pending" },
      { id: "goal-3", description: "Run tests to verify", status: "pending" },
    ];

    const responses = [
      // Turn 1: lands a WRONG edit on the correct target file, then finishes.
      `FILE: ${TARGET_PATH}\n\`\`\`ts\n${STILL_WRONG_SOURCE}\`\`\`\nTOOL: finish {"summary": "fixed it"}`,
      // Turn 2: wanders — edits an UNRELATED file instead of retrying the target.
      `TOOL: write_file {"path": "src/other.ts", "content": "export const x = 1;\\n"}\nTOOL: finish {"summary": "done"}`,
      // Turn 3: never used to change state further; just observe its prompt.
      `TOOL: think {}`,
    ];

    const provider = makeSequentialProvider(responses);
    const profile = makeProfile();
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile, reasoningHandler, config },
      async (_goal) => makeTargetContext(),
    );

    // The loop ran all 3 turns without ever solving the test.
    expect(finalState.turns).toHaveLength(3);
    expect(finalState.status).toBe("max_turns");

    // Core assertion: the loop did NOT advance off goal-1 despite `finish()`
    // firing on turns 1 and 2 — the target's test was still failing both times.
    expect(finalState.currentGoalIndex).toBe(0);
    expect(finalState.goals[0]?.status).not.toBe("done");
    expect(finalState.goals[0]?.status).toBe("in_progress");

    // Turn 2's prompt (built after turn 1's non-fixing edit) re-anchors to the
    // target file and the specific failing test, instead of moving on to
    // "Write tests" / "Run tests to verify".
    const turn2Prompt = finalState.turns[1]?.prompt ?? "";
    expect(turn2Prompt).toContain("## STAY ON TARGET");
    expect(turn2Prompt).toContain(`Edit ONLY \`${TARGET_PATH}\``);
    expect(turn2Prompt).toContain("adds two numbers");
    expect(turn2Prompt).not.toContain("step 2/3");
    expect(turn2Prompt).not.toContain("step 3/3");

    // Turn 3's prompt (built after turn 2 edited the UNRELATED src/other.ts)
    // names the off-target file and warns the model back onto the real target.
    const turn3Prompt = finalState.turns[2]?.prompt ?? "";
    expect(turn3Prompt).toContain("## STAY ON TARGET");
    expect(turn3Prompt).toContain("src/other.ts");
    expect(turn3Prompt).toContain(`the target is \`${TARGET_PATH}\``);
    expect(turn3Prompt).not.toContain("step 2/3");
    expect(turn3Prompt).not.toContain("step 3/3");
  });
});

// ---------------------------------------------------------------------------
// turnEditedPaths — pure helper unit tests
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turn: 1,
    goalId: "goal-1",
    prompt: "p",
    rawResponse: "r",
    answer: "a",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 10,
    completionTokens: 20,
    timestamp: 0,
    ...overrides,
  };
}

describe("turnEditedPaths", () => {
  it("collects applied edit-block paths (preferring effectivePath)", () => {
    const turn = makeTurn({
      applyResults: [
        { filePath: "src/a.ts", status: "applied", effectivePath: "src/a.ts" },
        { filePath: "src/b.ts", status: "not_found" },
      ],
    });
    expect(turnEditedPaths(turn)).toEqual(new Set(["src/a.ts"]));
  });

  it("collects write_file TOOL call paths", () => {
    const turn = makeTurn({
      toolCalls: [{ name: "write_file", args: { path: "src/c.ts", content: "x" } }],
    });
    expect(turnEditedPaths(turn)).toEqual(new Set(["src/c.ts"]));
  });

  it("returns an empty set when nothing was written", () => {
    expect(turnEditedPaths(makeTurn())).toEqual(new Set());
  });
});
