import { afterEach, describe, expect, test } from "bun:test";
import { reflectConfigFromEnv } from "../src/improve/gepa/reflective-mutator.ts";
import type { ProviderConfig } from "../src/config/types.ts";

// ---------------------------------------------------------------------------
// SMALLCODE_GEPA_REFLECT_TIMEOUT: a strong reflector (e.g. 32B) rewriting a full
// system prompt from many transcripts can exceed the executor's 180s provider
// timeout. When it does, complete() throws and the mutator silently no-ops to the
// parent, degrading GEPA to noise. The dedicated timeout knob must override the
// reflect provider's timeoutMs; absent, it inherits the fallback.
// ---------------------------------------------------------------------------

const FALLBACK: ProviderConfig = {
  baseUrl: "http://localhost:11434/v1",
  apiKey: "none",
  timeoutMs: 180_000,
};

const SAVE = { ...process.env };
afterEach(() => {
  for (const k of ["SMALLCODE_GEPA_REFLECT_MODEL", "SMALLCODE_GEPA_REFLECT_TIMEOUT"]) {
    if (SAVE[k] === undefined) delete process.env[k];
    else process.env[k] = SAVE[k];
  }
});

describe("reflectConfigFromEnv — timeout knob", () => {
  test("overrides provider.timeoutMs when SMALLCODE_GEPA_REFLECT_TIMEOUT is set", () => {
    process.env["SMALLCODE_GEPA_REFLECT_MODEL"] = "qwen2.5-coder:32b";
    process.env["SMALLCODE_GEPA_REFLECT_TIMEOUT"] = "600000";
    const cfg = reflectConfigFromEnv(FALLBACK);
    expect(cfg.provider.timeoutMs).toBe(600_000);
    expect(cfg.modelId).toBe("qwen2.5-coder:32b");
  });

  test("inherits the fallback timeout when the knob is unset", () => {
    process.env["SMALLCODE_GEPA_REFLECT_MODEL"] = "qwen2.5-coder:32b";
    delete process.env["SMALLCODE_GEPA_REFLECT_TIMEOUT"];
    const cfg = reflectConfigFromEnv(FALLBACK);
    expect(cfg.provider.timeoutMs).toBe(180_000);
  });

  test("ignores a non-numeric timeout (keeps fallback)", () => {
    process.env["SMALLCODE_GEPA_REFLECT_MODEL"] = "qwen2.5-coder:32b";
    process.env["SMALLCODE_GEPA_REFLECT_TIMEOUT"] = "not-a-number";
    const cfg = reflectConfigFromEnv(FALLBACK);
    expect(cfg.provider.timeoutMs).toBe(180_000);
  });
});
