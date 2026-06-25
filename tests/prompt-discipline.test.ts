import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../src/agent/index.ts";
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

describe("buildSystemPrompt — discipline rules toggle", () => {
  it("includes discipline rules when disciplineRules is omitted (default true)", () => {
    const prompt = buildSystemPrompt(makeProfile(), makeConfig());
    expect(prompt).toContain("DISCIPLINE");
    expect(prompt).toContain("MINIMUM code");
    expect(prompt).toContain("Change ONLY what the task requires");
  });

  it("includes discipline rules when disciplineRules is explicitly true", () => {
    const prompt = buildSystemPrompt(makeProfile(), makeConfig({ disciplineRules: true }));
    expect(prompt).toContain("DISCIPLINE");
    expect(prompt).toContain("MINIMUM code");
    expect(prompt).toContain("Change ONLY what the task requires");
  });

  it("omits discipline rules when disciplineRules is false", () => {
    const prompt = buildSystemPrompt(makeProfile(), makeConfig({ disciplineRules: false }));
    expect(prompt).not.toContain("DISCIPLINE");
    expect(prompt).not.toContain("MINIMUM code");
    expect(prompt).not.toContain("Change ONLY what the task requires");
  });

  it("never instructs the model to ask the user or surface tradeoffs", () => {
    const promptOn = buildSystemPrompt(makeProfile(), makeConfig({ disciplineRules: true }));
    const promptOff = buildSystemPrompt(makeProfile(), makeConfig({ disciplineRules: false }));

    for (const prompt of [promptOn, promptOff]) {
      expect(prompt.toLowerCase()).not.toContain("ask the user");
      expect(prompt.toLowerCase()).not.toContain("surface tradeoff");
    }
  });

  it("discipline rule 10 is format-aware (whole file in FILE: mode, whole function in PATCH: mode)", () => {
    const prompt = buildSystemPrompt(makeProfile(), makeConfig({ disciplineRules: true }));
    // Rule 10 must agree with the FILE:/PATCH: split, not demand the whole file
    // unconditionally (which contradicted the ## Edit Target PATCH directive and
    // sent small models into a format-deadlock think-spiral).
    expect(prompt).toContain("whole file in FILE: mode");
    expect(prompt).toContain("whole single function in PATCH: mode");
  });
});
