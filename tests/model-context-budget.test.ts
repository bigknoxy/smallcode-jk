/**
 * Tests for the num_ctx-aware context-budget helpers.
 *
 * Regression guard for the HTTP-400 overflow bug: the CLI used to budget repo
 * context as `contextWindow * 0.5` (32_768 for vibethinker) while Ollama runs
 * the model at `num_ctx` = 8_192 — a 4x overshoot. These helpers derive the
 * budget from the OPERATIVE window minus the generation reserve.
 */

import { describe, expect, it } from "bun:test";
import {
  contextBudgetFor,
  effectiveContextWindow,
  promptHardCap,
} from "../src/models/context-budget.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import type { ModelProfile } from "../src/models/types.ts";

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: "p",
    label: "P",
    contextWindow: 65_536,
    samplingDefaults: { temperature: 1, top_p: 0.95, top_k: -1, max_tokens: 4_096 },
    supportsGrammar: false,
    supportsJsonSchema: false,
    ...overrides,
  };
}

describe("effectiveContextWindow", () => {
  it("uses num_ctx when ollamaOptions sets it (overrides nominal contextWindow)", () => {
    const p = profile({ contextWindow: 65_536, ollamaOptions: { num_ctx: 8_192 } });
    expect(effectiveContextWindow(p)).toBe(8_192);
  });

  it("falls back to contextWindow when no ollamaOptions", () => {
    const p = profile({ contextWindow: 131_072, ollamaOptions: undefined });
    expect(effectiveContextWindow(p)).toBe(131_072);
  });

  it("falls back to contextWindow when ollamaOptions has no num_ctx", () => {
    const p = profile({ contextWindow: 32_768, ollamaOptions: { top_k: 40 } });
    expect(effectiveContextWindow(p)).toBe(32_768);
  });
});

describe("promptHardCap / contextBudgetFor", () => {
  it("reserves max_tokens from the operative window", () => {
    const p = profile({
      ollamaOptions: { num_ctx: 8_192 },
      samplingDefaults: { temperature: 1, top_p: 0.95, top_k: -1, max_tokens: 4_096 },
    });
    expect(promptHardCap(p)).toBe(8_192 - 4_096); // 4096
    expect(contextBudgetFor(p)).toBe(4_096);
  });

  it("never returns less than 1024 even if max_tokens exceeds the window", () => {
    const p = profile({
      contextWindow: 1_024,
      ollamaOptions: undefined,
      samplingDefaults: { temperature: 1, top_p: 0.95, top_k: -1, max_tokens: 4_096 },
    });
    expect(promptHardCap(p)).toBe(1_024);
  });

  it("is NOT derived from the nominal contextWindow when num_ctx is smaller", () => {
    const p = profile({ contextWindow: 65_536, ollamaOptions: { num_ctx: 8_192 } });
    // The old buggy formula gave 32_768; the fix must be far smaller.
    expect(contextBudgetFor(p)).toBeLessThan(32_768);
    expect(contextBudgetFor(p)).toBe(4_096);
  });
});

describe("real vibethinker-3b profile", () => {
  it("operative window is num_ctx (8192), not the nominal 65536", () => {
    const vibe = defaultRegistry.get("vibethinker-3b");
    expect(vibe.contextWindow).toBe(65_536); // nominal stays as-is
    expect(effectiveContextWindow(vibe)).toBe(8_192); // but operative is num_ctx
  });

  it("budget leaves the full generation reserve and fits the real window", () => {
    const vibe = defaultRegistry.get("vibethinker-3b");
    const budget = contextBudgetFor(vibe);
    // budget + max_tokens must not exceed the operative window
    expect(budget + vibe.samplingDefaults.max_tokens).toBeLessThanOrEqual(
      effectiveContextWindow(vibe),
    );
  });
});
