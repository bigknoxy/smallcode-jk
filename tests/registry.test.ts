import { describe, expect, it } from "bun:test";
import { defaultRegistry, ModelRegistry } from "../src/models/registry.ts";
import type { ModelProfile } from "../src/models/types.ts";

describe("ModelRegistry", () => {
  it("resolves vibethinker-3b profile", () => {
    const profile = defaultRegistry.get("vibethinker-3b");
    expect(profile.id).toBe("vibethinker-3b");
    expect(profile.contextWindow).toBe(65_536);
    expect(profile.samplingDefaults.temperature).toBe(1.0);
    expect(profile.reasoningTags?.open).toBe("<think>");
    expect(profile.reasoningTags?.close).toBe("</think>");
  });

  it("throws on unknown model id", () => {
    expect(() => defaultRegistry.get("nonexistent-model")).toThrow(/Unknown model profile/);
  });

  it("lists built-in profiles", () => {
    const profiles = defaultRegistry.list();
    expect(profiles.length).toBeGreaterThanOrEqual(3);
    expect(profiles.map((p) => p.id)).toContain("vibethinker-3b");
  });

  it("registers and retrieves custom profile", () => {
    const registry = new ModelRegistry();
    const custom: ModelProfile = {
      id: "custom-7b",
      label: "Custom 7B",
      contextWindow: 32_768,
      samplingDefaults: { temperature: 0.8, top_p: 0.9, top_k: 40, max_tokens: 2_048 },
      supportsGrammar: false,
      supportsJsonSchema: false,
    };
    registry.register(custom);
    expect(registry.get("custom-7b").label).toBe("Custom 7B");
    expect(registry.has("custom-7b")).toBe(true);
  });

  it("constructor accepts extra profiles", () => {
    const extra: ModelProfile = {
      id: "extra-3b",
      label: "Extra 3B",
      contextWindow: 8_192,
      samplingDefaults: { temperature: 1.0, top_p: 0.95, top_k: -1, max_tokens: 1_024 },
      supportsGrammar: false,
      supportsJsonSchema: false,
    };
    const registry = new ModelRegistry([extra]);
    expect(registry.get("extra-3b").id).toBe("extra-3b");
  });
});
