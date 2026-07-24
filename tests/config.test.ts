import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { applyEnvOverrides, loadConfig } from "../src/config/loader.ts";
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

  // Env overrides let a run point at a non-Ollama endpoint (e.g. a llama-server
  // on :8910) WITHOUT editing the checked-in config file. Regression guard: the
  // override was previously dead code (loadConfigFromEnv exported, never wired
  // in), so SMALLCODE_BASE_URL silently did nothing in the eval path.
  it("SMALLCODE_BASE_URL / SMALLCODE_MODEL override the file, keeping other fields", () => {
    const priorUrl = process.env["SMALLCODE_BASE_URL"];
    const priorModel = process.env["SMALLCODE_MODEL"];
    process.env["SMALLCODE_BASE_URL"] = "http://localhost:8910/v1";
    process.env["SMALLCODE_MODEL"] = "qwythos-9b";
    try {
      const { config } = loadConfig(FIXTURE_PATH);
      expect(config.provider.baseUrl).toBe("http://localhost:8910/v1");
      expect(config.activeModel).toBe("qwythos-9b");
      // apiKey/timeout come from the file/schema, not clobbered by the override.
      expect(config.provider.apiKey).toBe("none");
    } finally {
      if (priorUrl === undefined) delete process.env["SMALLCODE_BASE_URL"];
      else process.env["SMALLCODE_BASE_URL"] = priorUrl;
      if (priorModel === undefined) delete process.env["SMALLCODE_MODEL"];
      else process.env["SMALLCODE_MODEL"] = priorModel;
    }
  });
});

describe("applyEnvOverrides", () => {
  const BASE = SmallcodeConfigSchema.parse({
    provider: { baseUrl: "http://localhost:11434/v1" },
    activeModel: "vibethinker-3b",
  });

  it("is a no-op when no env vars are set", () => {
    const priorUrl = process.env["SMALLCODE_BASE_URL"];
    const priorModel = process.env["SMALLCODE_MODEL"];
    delete process.env["SMALLCODE_BASE_URL"];
    delete process.env["SMALLCODE_MODEL"];
    try {
      const out = applyEnvOverrides(BASE);
      expect(out.provider.baseUrl).toBe("http://localhost:11434/v1");
      expect(out.activeModel).toBe("vibethinker-3b");
    } finally {
      if (priorUrl !== undefined) process.env["SMALLCODE_BASE_URL"] = priorUrl;
      if (priorModel !== undefined) process.env["SMALLCODE_MODEL"] = priorModel;
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
