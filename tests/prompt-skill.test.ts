/**
 * Tests for the PromptSet.skill slot and buildSystemPrompt SKILL injection.
 *
 * Verifies:
 *   1. buildSystemPrompt WITH skill appends exactly one ## SKILL block.
 *   2. buildSystemPrompt WITHOUT skill is byte-identical to the no-skill default.
 *   3. defaultPromptSet({ skill }) carries skill through.
 *   4. Empty/whitespace-only skill produces no SKILL block.
 *   5. disciplineRules behaviour is preserved when skill is added.
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

describe("buildSystemPrompt — skill injection", () => {
  it("WITHOUT skill is byte-identical to the no-skill default", () => {
    const config = makeConfig(); // no promptSet, no skill
    const result = buildSystemPrompt(makeProfile(), config);
    const expected = defaultPromptSet().system;
    expect(result).toBe(expected);
  });

  it("WITH skill appends exactly one ## SKILL block", () => {
    const skillText = "- Always read the file first.\n- Run tests after edits.";
    const ps = defaultPromptSet({ skill: skillText });
    const config = makeConfig({ promptSet: ps });
    const result = buildSystemPrompt(makeProfile(), config);

    // Must contain exactly one ## SKILL heading.
    const matches = result.match(/^## SKILL$/gm);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(1);

    // Skill content must follow the heading.
    expect(result).toContain(`## SKILL\n${skillText}`);
  });

  it("skill block is appended AFTER the base system prompt", () => {
    const skillText = "SKILL_SENTINEL_UNIQUE_XYZ";
    const ps = defaultPromptSet({ skill: skillText });
    const config = makeConfig({ promptSet: ps });
    const result = buildSystemPrompt(makeProfile(), config);

    const baseEnd = result.indexOf(skillText);
    const baseStart = result.indexOf("You are smallcode");
    expect(baseStart).toBeGreaterThan(-1);
    expect(baseEnd).toBeGreaterThan(baseStart);
  });

  it("empty string skill produces no SKILL block (byte-identical to baseline)", () => {
    const ps = defaultPromptSet({ skill: "" });
    const config = makeConfig({ promptSet: ps });
    const result = buildSystemPrompt(makeProfile(), config);

    expect(result).not.toContain("## SKILL");
    // Must equal the base default (no trailing block).
    const expected = defaultPromptSet().system;
    expect(result).toBe(expected);
  });

  it("whitespace-only skill produces no SKILL block", () => {
    const ps = defaultPromptSet({ skill: "   \n\t  " });
    const config = makeConfig({ promptSet: ps });
    const result = buildSystemPrompt(makeProfile(), config);
    expect(result).not.toContain("## SKILL");
  });

  it("skill is preserved alongside disciplineRules:true", () => {
    const skillText = "MY_SKILL_CONTENT";
    const ps = defaultPromptSet({ disciplineRules: true, skill: skillText });
    const config = makeConfig({ promptSet: ps });
    const result = buildSystemPrompt(makeProfile(), config);

    expect(result).toContain("## DISCIPLINE");
    expect(result).toContain("## SKILL");
    expect(result).toContain(skillText);
  });

  it("skill is preserved when disciplineRules:false", () => {
    const skillText = "SKILL_WITHOUT_RULES";
    const ps = defaultPromptSet({ disciplineRules: false, skill: skillText });
    const config = makeConfig({ promptSet: ps });
    const result = buildSystemPrompt(makeProfile(), config);

    expect(result).not.toContain("## DISCIPLINE");
    expect(result).toContain("## SKILL");
    expect(result).toContain(skillText);
  });
});

describe("defaultPromptSet — skill slot", () => {
  it("skill is undefined when not passed", () => {
    const ps = defaultPromptSet();
    expect(ps.skill).toBeUndefined();
  });

  it("skill is carried through when passed", () => {
    const ps = defaultPromptSet({ skill: "MY_SKILL" });
    expect(ps.skill).toBe("MY_SKILL");
  });

  it("skill does not affect planner or reflection prompts", () => {
    const withSkill = defaultPromptSet({ skill: "MY_SKILL" });
    const withoutSkill = defaultPromptSet();
    expect(withSkill.planner).toBe(withoutSkill.planner);
    expect(withSkill.reflection).toBe(withoutSkill.reflection);
  });
});
