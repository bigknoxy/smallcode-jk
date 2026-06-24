/**
 * Tests for the prompt-as-variable seam (2a).
 *
 * Verifies that:
 *   1. buildSystemPrompt with a custom promptSet returns candidate.system verbatim.
 *   2. buildSystemPrompt without promptSet produces the same output as before (default).
 *   3. disciplineRules:false still strips the discipline block via the seam.
 */

import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { defaultPromptSet } from "../src/agent/prompt-set.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import type { ModelProfile } from "../src/models/types.ts";

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
    repoRoot: "/tmp/test",
    modelId: "test-model",
    maxTurns: 10,
    bestOfN: 1,
    ...overrides,
  };
}

describe("buildSystemPrompt — promptSet seam", () => {
  it("returns candidate system prompt verbatim when promptSet is supplied", () => {
    const customSystem = "CUSTOM_SYSTEM_PROMPT_UNIQUE_VALUE_XYZ";
    const ps = { ...defaultPromptSet(), system: customSystem };
    const config = makeConfig({ promptSet: ps });
    const result = buildSystemPrompt(makeProfile(), config);
    expect(result).toBe(customSystem);
  });

  it("without promptSet, output matches defaultPromptSet({ disciplineRules: true })", () => {
    const config = makeConfig(); // no promptSet
    const result = buildSystemPrompt(makeProfile(), config);
    const expected = defaultPromptSet({ disciplineRules: true }).system;
    expect(result).toBe(expected);
  });

  it("without promptSet + disciplineRules:false, output matches defaultPromptSet({ disciplineRules: false })", () => {
    const config = makeConfig({ disciplineRules: false });
    const result = buildSystemPrompt(makeProfile(), config);
    const expected = defaultPromptSet({ disciplineRules: false }).system;
    expect(result).toBe(expected);
    expect(result).not.toContain("DISCIPLINE");
  });

  it("promptSet takes precedence over disciplineRules flag", () => {
    // Supply a promptSet; disciplineRules:false should be ignored
    const customSystem = "PROMPTSET_WINS";
    const ps = { ...defaultPromptSet({ disciplineRules: true }), system: customSystem };
    const config = makeConfig({ promptSet: ps, disciplineRules: false });
    const result = buildSystemPrompt(makeProfile(), config);
    expect(result).toBe(customSystem);
  });

  it("default output contains DISCIPLINE when no promptSet", () => {
    const config = makeConfig();
    const result = buildSystemPrompt(makeProfile(), config);
    expect(result).toContain("DISCIPLINE");
  });

  it("default output omits DISCIPLINE when disciplineRules:false and no promptSet", () => {
    const config = makeConfig({ disciplineRules: false });
    const result = buildSystemPrompt(makeProfile(), config);
    expect(result).not.toContain("DISCIPLINE");
  });
});

describe("defaultPromptSet()", () => {
  it("planner prompt contains 'sub-goals'", () => {
    const ps = defaultPromptSet();
    expect(ps.planner).toContain("sub-goals");
  });

  it("reflection prompt contains 'Briefly reflect'", () => {
    const ps = defaultPromptSet();
    expect(ps.reflection).toContain("Briefly reflect");
  });

  it("discipline off strips the block but keeps base rules", () => {
    const with_ = defaultPromptSet({ disciplineRules: true });
    const without = defaultPromptSet({ disciplineRules: false });
    expect(with_.system).toContain("DISCIPLINE");
    expect(without.system).not.toContain("DISCIPLINE");
    // Core content still present
    expect(without.system).toContain("HOW TO EDIT A FILE");
  });
});
