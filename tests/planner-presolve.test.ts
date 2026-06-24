import { describe, expect, it } from "bun:test";
import { planTask } from "../src/agent/index.ts";
import type { PlannerOptions } from "../src/agent/planner.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  StreamChunk,
} from "../src/provider/types.ts";

// ---------------------------------------------------------------------------
// Helpers
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

function makeContext(): ContextBundle {
  return {
    chunks: [],
    totalTokens: 0,
    tokenBudget: 2048,
    truncated: false,
    query: "test goal",
  };
}

/**
 * Builds a Provider that records every call made to it and returns
 * `responses` in order (cycling on the last entry if exhausted).
 */
function makeRecordingProvider(responses: string[]): { provider: Provider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const provider: Provider = {
    complete: async (req: CompletionRequest): Promise<CompletionResponse> => {
      calls.push(req);
      const idx = Math.min(calls.length - 1, responses.length - 1);
      return {
        rawContent: responses[idx] ?? "",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      };
    },
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "", done: true };
    },
  };
  return { provider, calls };
}

function makeOpts(provider: Provider, overrides: Partial<PlannerOptions> = {}): PlannerOptions {
  return {
    provider,
    modelId: "test-model",
    profile: makeProfile(),
    repoRoot: "/tmp/test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("planTask — pre-solve reflection disabled (default)", () => {
  it("makes exactly 1 provider call when preSolveReflection is omitted", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Read foo\n2. Write bar"]);
    const goals = await planTask("fix the bug", makeContext(), makeOpts(provider));

    expect(calls).toHaveLength(1);
    expect(goals).toHaveLength(2);
  });

  it("makes exactly 1 provider call when preSolveReflection is false", async () => {
    const { provider, calls } = makeRecordingProvider(["1. Read foo\n2. Write bar"]);
    const goals = await planTask("fix the bug", makeContext(), makeOpts(provider, { preSolveReflection: false }));

    expect(calls).toHaveLength(1);
    expect(goals).toHaveLength(2);
    // The single call should use the planning system prompt (not the reflection prompt)
    expect(calls[0]?.messages[0]?.content).toContain("sub-goals");
  });
});

describe("planTask — pre-solve reflection enabled", () => {
  it("makes 2 provider calls when preSolveReflection is true", async () => {
    const { provider, calls } = makeRecordingProvider([
      "The task asks to fix a null-pointer bug; key constraint is that parseConfig may return undefined.",
      "1. Read src/config.ts\n2. Add null check in parseConfig\n3. Run tests",
    ]);

    await planTask("fix null bug", makeContext(), makeOpts(provider, { preSolveReflection: true }));

    expect(calls).toHaveLength(2);
    // First call is the reflection step
    expect(calls[0]?.messages[0]?.content).toContain("Briefly reflect");
    expect(calls[0]?.max_tokens).toBe(128);
    // Second call is the planning step
    expect(calls[1]?.messages[0]?.content).toContain("sub-goals");
  });

  it("feeds reflection output into the planning prompt", async () => {
    const reflectionText = "Core problem: missing await. Edge case: concurrent calls.";
    const { provider, calls } = makeRecordingProvider([
      reflectionText,
      "1. Add await\n2. Run tests",
    ]);

    await planTask("fix async bug", makeContext(), makeOpts(provider, { preSolveReflection: true }));

    expect(calls).toHaveLength(2);
    // The planning user message should include the reflection text
    const planUserMessage = calls[1]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(planUserMessage).toContain(reflectionText);
    expect(planUserMessage).toContain("Key observations:");
  });

  it("still returns Goal[] with correct shape", async () => {
    const { provider } = makeRecordingProvider([
      "Note key constraint: function may throw.",
      "1. Read utils.ts\n2. Wrap in try/catch\n3. Verify tests pass",
    ]);

    const goals = await planTask("add error handling", makeContext(), makeOpts(provider, { preSolveReflection: true }));

    expect(Array.isArray(goals)).toBe(true);
    expect(goals.length).toBeGreaterThan(0);
    for (const g of goals) {
      expect(typeof g.id).toBe("string");
      expect(typeof g.description).toBe("string");
      expect(g.status).toBe("pending");
    }
  });

  it("falls back gracefully if reflection provider call fails", async () => {
    let callCount = 0;
    const provider: Provider = {
      complete: async (_req: CompletionRequest): Promise<CompletionResponse> => {
        callCount++;
        if (callCount === 1) throw new Error("reflection network error");
        return {
          rawContent: "1. Do the thing\n2. Run tests",
          model: "test-model",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
        };
      },
      stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
        yield { delta: "", done: true };
      },
    };

    const goals = await planTask("some task", makeContext(), makeOpts(provider, { preSolveReflection: true }));

    // Even with failed reflection, goals should be parsed from the planning step
    expect(goals).toHaveLength(2);
    expect(goals[0]?.status).toBe("pending");
  });
});
