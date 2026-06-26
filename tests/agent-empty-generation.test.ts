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
// A provider that simulates a WEDGED backend: empty raw content + zero
// completion tokens (a flapping local Ollama returns {"response":"","done":false}).
// The loop must tag these turns "infra: empty model generation" rather than
// silently scoring a clean 0.00 — see project_ollama_slowdown (2026-06-26).
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  rawContent: string;
  completionTokens: number;
  truncated?: boolean;
}

function makeSequenceProvider(script: ScriptedResponse[]): Provider {
  let i = 0;
  return {
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => {
      const r = script[Math.min(i, script.length - 1)] ?? {
        rawContent: "",
        completionTokens: 0,
      };
      i++;
      return {
        rawContent: r.rawContent,
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: r.completionTokens, totalTokens: 10 + r.completionTokens },
        finishReason: r.truncated ? "length" : "stop",
        truncated: r.truncated ?? false,
      };
    },
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "", done: true };
    },
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

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { repoRoot: "/tmp/test-repo", modelId: "test-model", maxTurns: 5, bestOfN: 1, ...overrides };
}

function makeContext(): ContextBundle {
  return { chunks: [], totalTokens: 0, tokenBudget: 2048, truncated: false, query: "goal" };
}

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `smallcode-empty-${process.pid}-${performance.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("runLoop empty-generation (wedged backend) detection", () => {
  it("tags an empty zero-token response as an infra error, not think-only", async () => {
    const config = makeConfig({ repoRoot: testDir, maxTurns: 3 });
    const state = createState(config, "fix the bug");
    state.goals = [{ id: "goal-1", description: "Do the thing", status: "pending" }];

    // Every turn comes back empty with zero completion tokens — the wedge signature.
    const provider = makeSequenceProvider([{ rawContent: "", completionTokens: 0 }]);
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile: makeProfile(), reasoningHandler, config },
      async (_goal) => makeContext(),
    );

    // Every turn must carry the infra-empty tag (so the eval can drop the trial)...
    expect(finalState.turns.length).toBeGreaterThan(0);
    for (const t of finalState.turns) {
      const err = t.toolResults[0]?.error ?? "";
      expect(err).toContain("infra: empty model generation");
      // ...and NOT be misclassified as a think-only truncation.
      expect(err).not.toContain("think-only");
    }
  });

  it("does NOT flag a real (non-empty) generation as infra", async () => {
    const config = makeConfig({ repoRoot: testDir, maxTurns: 2 });
    const state = createState(config, "ordinary task");
    state.goals = [{ id: "goal-1", description: "Work on it", status: "pending" }];

    // A normal turn: real tokens, real prose. Must never be tagged infra.
    const provider = makeSequenceProvider([
      { rawContent: "Here is some prose but no tool call.", completionTokens: 12 },
    ]);
    const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(
      state,
      statePath,
      { provider, profile: makeProfile(), reasoningHandler, config },
      async (_goal) => makeContext(),
    );

    expect(
      finalState.turns.every(
        (t) => !(t.toolResults[0]?.error ?? "").includes("infra: empty model generation"),
      ),
    ).toBe(true);
  });
});
