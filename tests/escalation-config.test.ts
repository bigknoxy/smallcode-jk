import { test, expect, describe } from "bun:test";
import { SmallcodeConfigSchema } from "../src/config/types.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { buildEscalationLadder } from "../src/agent/escalation.ts";

const baseConfig = {
  provider: { baseUrl: "http://localhost:11434/v1", apiKey: "none", timeoutMs: 120000 },
  activeModel: "qwen2.5-coder:3b",
};

describe("config escalation field", () => {
  test("defaults to [] when omitted (low-resource: 3b alone)", () => {
    const cfg = SmallcodeConfigSchema.parse(baseConfig);
    expect(cfg.escalation).toEqual([]);
  });

  test("accepts a model ladder", () => {
    const cfg = SmallcodeConfigSchema.parse({
      ...baseConfig,
      bestOfN: 3,
      escalation: ["qwen2.5-coder:3b", "qwen2.5-coder:7b", "gemma4:12b"],
    });
    expect(cfg.escalation).toEqual(["qwen2.5-coder:3b", "qwen2.5-coder:7b", "gemma4:12b"]);
  });
});

describe("registry exposes higher rungs for bigger hardware", () => {
  test("gemma4:12b is selectable as an escalation rung", () => {
    const p = defaultRegistry.get("gemma4:12b");
    expect(p.id).toBe("gemma4:12b");
    expect(p.contextWindow).toBeGreaterThan(32_768);
  });

  test("a full local ladder 3b→7b→gemma12b resolves through the real registry", () => {
    const ladder = buildEscalationLadder({
      spec: "qwen2.5-coder:3b,qwen2.5-coder:7b,gemma4:12b",
      registry: defaultRegistry,
      provider: { name: "ollama" } as any,
    });
    expect(ladder?.map((r) => r.id)).toEqual([
      "qwen2.5-coder:3b",
      "qwen2.5-coder:7b",
      "gemma4:12b",
    ]);
    // Each rung carries its own profile (distinct windows) — escalation retargets both.
    expect(ladder?.map((r) => r.profile.id)).toEqual([
      "qwen2.5-coder:3b",
      "qwen2.5-coder:7b",
      "gemma4:12b",
    ]);
  });
});
