import { afterEach, describe, expect, it } from "bun:test";
import { ENV_REGISTRY, env } from "../src/config/env.ts";

// ---------------------------------------------------------------------------
// Save + restore process.env around every test so overrides don't leak into
// other test files (bun test shares one process).
// ---------------------------------------------------------------------------

const TRACKED = ENV_REGISTRY.map((e) => e.name);
const saved: Record<string, string | undefined> = {};

function snapshot(): void {
  for (const name of TRACKED) saved[name] = process.env[name];
}

function restore(): void {
  for (const name of TRACKED) {
    const v = saved[name];
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
}

snapshot();
afterEach(restore);

describe("ENV_REGISTRY", () => {
  it("has 14 entries", () => {
    expect(ENV_REGISTRY.length).toBe(14);
  });

  it("every env getter name appears in ENV_REGISTRY", () => {
    const registryNames = new Set(ENV_REGISTRY.map((e) => e.name));
    const expected = [
      "SMALLCODE_LOCALIZE",
      "SMALLCODE_VALIDATE_EDIT",
      "SMALLCODE_STATIC_CONFIDENCE",
      "SMALLCODE_DIFF_EDIT",
      "SMALLCODE_DIFF_MIN_FN",
      "SMALLCODE_TARGET_PIN",
      "SMALLCODE_GRADER_RETRIES",
      "SMALLCODE_WATCHDOG",
      "SMALLCODE_TARGET_LOCK",
      "SMALLCODE_PHASE_GATE",
      "SMALLCODE_SAVE_TRANSCRIPTS",
      "SMALLCODE_R2_FORCE_LINE",
      "SMALLCODE_MUTATION_REPAIR",
      "SMALLCODE_MUTATION_REPAIR_MAX",
    ];
    for (const name of expected) {
      expect(registryNames.has(name)).toBe(true);
    }
  });
});

describe("env.localize (default OFF)", () => {
  it("unset -> false", () => {
    delete process.env["SMALLCODE_LOCALIZE"];
    expect(env.localize).toBe(false);
  });
  it('"1" -> true', () => {
    process.env["SMALLCODE_LOCALIZE"] = "1";
    expect(env.localize).toBe(true);
  });
  it('"0" -> false', () => {
    process.env["SMALLCODE_LOCALIZE"] = "0";
    expect(env.localize).toBe(false);
  });
});

describe("env.validateEdit (default ON)", () => {
  it("unset -> true", () => {
    delete process.env["SMALLCODE_VALIDATE_EDIT"];
    expect(env.validateEdit).toBe(true);
  });
  it('"0" -> false', () => {
    process.env["SMALLCODE_VALIDATE_EDIT"] = "0";
    expect(env.validateEdit).toBe(false);
  });
  it('"1" -> true', () => {
    process.env["SMALLCODE_VALIDATE_EDIT"] = "1";
    expect(env.validateEdit).toBe(true);
  });
});

describe("env.staticConfidence (default ON)", () => {
  it("unset -> true", () => {
    delete process.env["SMALLCODE_STATIC_CONFIDENCE"];
    expect(env.staticConfidence).toBe(true);
  });
  it('"0" -> false', () => {
    process.env["SMALLCODE_STATIC_CONFIDENCE"] = "0";
    expect(env.staticConfidence).toBe(false);
  });
});

describe("env.diffEdit (default ON)", () => {
  it("unset -> true", () => {
    delete process.env["SMALLCODE_DIFF_EDIT"];
    expect(env.diffEdit).toBe(true);
  });
  it('"0" -> false', () => {
    process.env["SMALLCODE_DIFF_EDIT"] = "0";
    expect(env.diffEdit).toBe(false);
  });
});

describe("env.diffMinFnLines (default 30)", () => {
  it("unset -> 30", () => {
    delete process.env["SMALLCODE_DIFF_MIN_FN"];
    expect(env.diffMinFnLines).toBe(30);
  });
  it('"15" -> 15', () => {
    process.env["SMALLCODE_DIFF_MIN_FN"] = "15";
    expect(env.diffMinFnLines).toBe(15);
  });
  it("NaN guard falls back to default", () => {
    process.env["SMALLCODE_DIFF_MIN_FN"] = "not-a-number";
    expect(env.diffMinFnLines).toBe(30);
  });
});

describe("env.targetPin (default ON)", () => {
  it("unset -> true", () => {
    delete process.env["SMALLCODE_TARGET_PIN"];
    expect(env.targetPin).toBe(true);
  });
  it('"0" -> false', () => {
    process.env["SMALLCODE_TARGET_PIN"] = "0";
    expect(env.targetPin).toBe(false);
  });
});

describe("env.graderRetries (default 1)", () => {
  it("unset -> 1", () => {
    delete process.env["SMALLCODE_GRADER_RETRIES"];
    expect(env.graderRetries).toBe(1);
  });
  it('"3" -> 3', () => {
    process.env["SMALLCODE_GRADER_RETRIES"] = "3";
    expect(env.graderRetries).toBe(3);
  });
  it("NaN guard falls back to default", () => {
    process.env["SMALLCODE_GRADER_RETRIES"] = "nope";
    expect(env.graderRetries).toBe(1);
  });
});

describe("env.watchdog (default ON)", () => {
  it("unset -> true", () => {
    delete process.env["SMALLCODE_WATCHDOG"];
    expect(env.watchdog).toBe(true);
  });
  it('"0" -> false', () => {
    process.env["SMALLCODE_WATCHDOG"] = "0";
    expect(env.watchdog).toBe(false);
  });
});

describe("env.targetLock (default ON)", () => {
  it("unset -> true", () => {
    delete process.env["SMALLCODE_TARGET_LOCK"];
    expect(env.targetLock).toBe(true);
  });
  it('"0" -> false', () => {
    process.env["SMALLCODE_TARGET_LOCK"] = "0";
    expect(env.targetLock).toBe(false);
  });
});
