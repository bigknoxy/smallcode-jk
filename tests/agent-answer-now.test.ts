import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, runLoop } from "../src/agent/index.ts";
import type { AgentConfig } from "../src/agent/types.ts";
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
// Helpers — a provider that returns a different scripted response per call,
// so we can simulate a think-only truncation followed by a real answer.
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  rawContent: string;
  truncated?: boolean;
}

function makeSequenceProvider(script: ScriptedResponse[]): {
  provider: Provider;
  prompts: string[];
} {
  const prompts: string[] = [];
  let i = 0;
  const provider: Provider = {
    complete: async (req: CompletionRequest): Promise<CompletionResponse> => {
      const userMsg = req.messages.find((m) => m.role === "user");
      prompts.push(userMsg?.content ?? "");
      const r = script[Math.min(i, script.length - 1)] ?? { rawContent: "" };
      i++;
      return {
        rawContent: r.rawContent,
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: r.truncated ? "length" : "stop",
        truncated: r.truncated ?? false,
      };
    },
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "", done: true };
    },
  };
  return { provider, prompts };
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

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    repoRoot: "/tmp/test-repo",
    modelId: "test-model",
    maxTurns: 5,
    bestOfN: 1,
    ...overrides,
  };
}

function makeContext(): ContextBundle {
  return { chunks: [], totalTokens: 0, tokenBudget: 2048, truncated: false, query: "goal" };
}

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `smallcode-answernow-${process.pid}-${performance.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Think-only truncation → answer-now recovery on the next turn
// ---------------------------------------------------------------------------

describe("runLoop think-only recovery", () => {
  it("after a truncated think-only turn, drafts the next turn under ANSWER NOW", async () => {
    const config = makeConfig({ repoRoot: testDir, maxTurns: 5 });
    const state = createState(config, "make the thing work");
    state.goals = [{ id: "goal-1", description: "Do the thing", status: "pending" }];

    // Turn 1: model emits reasoning with NO close tag and finish_reason=length
    // → think-only truncation. Turn 2: a clean finish.
    const { provider, prompts } = makeSequenceProvider([
      {
        rawContent: "<think>let me reason about this at great length and never stop",
        truncated: true,
      },
      { rawContent: 'TOOL: finish {"summary": "done"}', truncated: false },
    ]);

    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile: makeProfile(), reasoningHandler, config },
      async (_goal) => makeContext(),
    );

    // Turn 1 recorded as a failed think-only turn.
    expect(finalState.turns).toHaveLength(2);
    expect(finalState.turns[0]?.answer).toBe("");
    expect(finalState.turns[0]?.toolResults[0]?.error).toContain("think-only");
    expect(finalState.turns[0]?.answerNow).toBeUndefined();

    // Turn 2 was drafted under the ANSWER-NOW recovery prompt.
    expect(finalState.turns[1]?.answerNow).toBe(true);
    expect(prompts[1]).toContain("ANSWER NOW");

    // And it recovered: finish advanced the goal.
    expect(finalState.status).toBe("done");
  });

  it("does not set answer-now after an ordinary (non-truncated) turn", async () => {
    const config = makeConfig({ repoRoot: testDir, maxTurns: 3 });
    const state = createState(config, "ordinary task");
    state.goals = [{ id: "goal-1", description: "Work on it", status: "pending" }];

    // A normal turn that produces a real answer (no truncation), no finish.
    const { provider, prompts } = makeSequenceProvider([
      { rawContent: "Here is some prose but no tool call.", truncated: false },
    ]);

    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile: makeProfile(), reasoningHandler, config },
      async (_goal) => makeContext(),
    );

    // No turn should ever carry the answer-now flag, and no prompt mentions it.
    expect(finalState.turns.every((t) => t.answerNow !== true)).toBe(true);
    expect(prompts.every((p) => !p.includes("ANSWER NOW"))).toBe(true);
  });
});
