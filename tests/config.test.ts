import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config/loader.ts";
import { SmallcodeConfigSchema } from "../src/config/types.ts";

const FIXTURE_PATH = "smallcode.config.test.json";

const VALID_CONFIG = {
  config: {
    provider: { baseUrl: "http://localhost:11434/v1" },
    activeModel: "vibethinker-3b",
  },
};

beforeAll(() => {
  writeFileSync(FIXTURE_PATH, JSON.stringify(VALID_CONFIG));
});

afterAll(() => {
  unlinkSync(FIXTURE_PATH);
});

describe("loadConfig", () => {
  it("loads a valid config file", () => {
    const { config, extraModels } = loadConfig(FIXTURE_PATH);
    expect(config.activeModel).toBe("vibethinker-3b");
    expect(config.provider.baseUrl).toBe("http://localhost:11434/v1");
    expect(extraModels).toHaveLength(0);
  });

  it("applies schema defaults", () => {
    const { config } = loadConfig(FIXTURE_PATH);
    expect(config.maxTurns).toBe(15);
    expect(config.bestOfN).toBe(1);
    expect(config.sandbox.enabled).toBe(true);
    expect(config.sandbox.requireApproval).toBe(true);
    expect(config.sandbox.networkAccess).toBe(false);
  });

  it("throws on missing config file", () => {
    expect(() => loadConfig("nonexistent.json")).toThrow(/No config file found/);
  });

  it("throws on invalid config", () => {
    const bad = "smallcode.config.bad.json";
    writeFileSync(
      bad,
      JSON.stringify({ config: { provider: { baseUrl: "not-a-url" }, activeModel: "x" } }),
    );
    try {
      expect(() => loadConfig(bad)).toThrow(/invalid/i);
    } finally {
      unlinkSync(bad);
    }
  });
});

describe("SmallcodeConfigSchema", () => {
  it("validates correct config", () => {
    const result = SmallcodeConfigSchema.safeParse(VALID_CONFIG.config);
    expect(result.success).toBe(true);
  });

  it("rejects invalid baseUrl", () => {
    const result = SmallcodeConfigSchema.safeParse({
      provider: { baseUrl: "not-a-url" },
      activeModel: "vibethinker-3b",
    });
    expect(result.success).toBe(false);
  });
});
