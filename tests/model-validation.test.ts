import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configInitCommand } from "../src/cli/commands/config-init.ts";
import { ModelRegistry, validateModelId } from "../src/models/registry.ts";

/**
 * E2-T4 — catch a typo'd / unknown model id at CONFIG time, not at the first
 * inference. `validateModelId` is the pure check; `config init` enforces it.
 */
describe("validateModelId", () => {
  const reg = new ModelRegistry();
  it("accepts a known registry id", () => {
    expect(validateModelId("qwen2.5-coder:3b", reg).ok).toBe(true);
  });
  it("rejects an unknown id and lists the known ids in the message", () => {
    const v = validateModelId("qwen2.5-codr:3b", reg); // typo
    expect(v.ok).toBe(false);
    expect(v.message).toContain('Unknown model id "qwen2.5-codr:3b"');
    expect(v.message).toContain("qwen2.5-coder:3b"); // a real id is offered
  });
  it("accepts a custom profile registered as an extra", () => {
    const withExtra = new ModelRegistry([
      {
        id: "my-local:latest",
        label: "Custom",
        contextWindow: 8192,
        samplingDefaults: { temperature: 0.2, top_p: 0.9, top_k: 20, max_tokens: 1024 },
        supportsGrammar: false,
        supportsJsonSchema: false,
      },
    ]);
    expect(validateModelId("my-local:latest", withExtra).ok).toBe(true);
  });
});

describe("config init — model validation", () => {
  let dir: string;
  const run = async (flags: Record<string, string | boolean>): Promise<number | undefined> => {
    const originalExit = process.exit.bind(process);
    let code: number | undefined;
    (process as unknown as Record<string, unknown>)["exit"] = (c?: number) => {
      code = c;
      throw new Error(`exit(${c})`);
    };
    try {
      await configInitCommand({ command: "config", subcommand: "init", positionals: [], flags });
    } catch {
      // exit throws in the mock
    } finally {
      (process as unknown as Record<string, unknown>)["exit"] = originalExit;
    }
    return code;
  };

  it("rejects a typo'd --model with exit 1 and writes NO config file", async () => {
    dir = mkdtempSync(join(tmpdir(), "cfg-validate-"));
    const out = join(dir, "smallcode.config.json");
    const code = await run({ output: out, model: "qwen-typo:3b" });
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false); // never wrote a config with a bad model
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a valid --model and writes the config", async () => {
    dir = mkdtempSync(join(tmpdir(), "cfg-validate-"));
    const out = join(dir, "smallcode.config.json");
    const code = await run({ output: out, model: "qwen2.5-coder:3b" });
    expect(code).toBeUndefined(); // no exit
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf-8")).config.activeModel).toBe("qwen2.5-coder:3b");
    rmSync(dir, { recursive: true, force: true });
  });
});
