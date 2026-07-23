import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { configInitCommand } from "../src/cli/commands/config-init.ts";
import { configModelsCommand } from "../src/cli/commands/config-models.ts";
import { ProgressDisplay } from "../src/cli/progress.ts";

// ---------------------------------------------------------------------------
// parseArgs tests
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("run command with positionals", () => {
    const result = parseArgs(["run", "fix", "the", "bug"]);
    expect(result.command).toBe("run");
    expect(result.positionals).toEqual(["fix", "the", "bug"]);
  });

  it("R9 chat / diff / undo commands parse with flags", () => {
    expect(parseArgs(["chat", "--repo", "/p", "--model", "qwen2.5-coder:3b"]).command).toBe("chat");
    expect(parseArgs(["diff", "--repo", "/p"]).command).toBe("diff");
    const undo = parseArgs(["undo", "--repo", "/p", "--yes"]);
    expect(undo.command).toBe("undo");
    expect(undo.flags["yes"]).toBe(true);
  });

  it("eval run with flags", () => {
    const result = parseArgs(["eval", "run", "./suite", "--model", "vibethinker-3b"]);
    expect(result.command).toBe("eval");
    expect(result.subcommand).toBe("run");
    expect(result.positionals).toEqual(["./suite"]);
    expect(result.flags["model"]).toBe("vibethinker-3b");
  });

  it("--version flag returns version command", () => {
    const result = parseArgs(["--version"]);
    expect(result.command).toBe("version");
  });

  it("-v flag returns version command", () => {
    const result = parseArgs(["-v"]);
    expect(result.command).toBe("version");
  });

  it("--help flag returns help command", () => {
    const result = parseArgs(["--help"]);
    expect(result.command).toBe("help");
  });

  it("-h flag returns help command", () => {
    const result = parseArgs(["-h"]);
    expect(result.command).toBe("help");
  });

  it("config init with endpoint flag", () => {
    const result = parseArgs(["config", "init", "--endpoint", "http://localhost:11434/v1"]);
    expect(result.command).toBe("config");
    expect(result.subcommand).toBe("init");
    expect(result.flags["endpoint"]).toBe("http://localhost:11434/v1");
  });

  it("eval gate with threshold flag", () => {
    const result = parseArgs(["eval", "gate", "./suite", "--threshold", "0.9"]);
    expect(result.command).toBe("eval");
    expect(result.subcommand).toBe("gate");
    expect(result.positionals).toEqual(["./suite"]);
    expect(result.flags["threshold"]).toBe("0.9");
  });

  it("empty argv returns help", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("help");
  });

  it("--flag=value syntax", () => {
    const result = parseArgs(["eval", "run", "./suite", "--model=qwen2.5-coder-7b"]);
    expect(result.flags["model"]).toBe("qwen2.5-coder-7b");
  });

  it("boolean flag with no value", () => {
    const result = parseArgs(["config", "init", "--force"]);
    expect(result.flags["force"]).toBe(true);
  });

  it("negative-number flag value is captured, not dropped", () => {
    const result = parseArgs(["run", "task", "--max-turns", "-1"]);
    expect(result.flags["max-turns"]).toBe("-1");
    expect(result.positionals).toEqual(["task"]);
  });

  it("negative decimal flag value is captured", () => {
    const result = parseArgs(["eval", "run", "--threshold", "-0.5"]);
    expect(result.flags["threshold"]).toBe("-0.5");
  });

  it("boolean flag followed by another flag stays boolean (not swallowed)", () => {
    // Guards against the over-general fix `if (next !== undefined)` which would
    // wrongly capture the following flag as this flag's value.
    const result = parseArgs(["config", "init", "--force", "--verbose"]);
    expect(result.flags["force"]).toBe(true);
    expect(result.flags["verbose"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProgressDisplay tests
// ---------------------------------------------------------------------------

describe("ProgressDisplay", () => {
  it("showComplete produces output with turn count", () => {
    const chunks: string[] = [];
    const fakeStream = {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const display = new ProgressDisplay(fakeStream);
    const state = {
      sessionId: "test-session",
      task: "test",
      repoRoot: "/tmp",
      modelId: "vibethinker-3b",
      goals: [],
      currentGoalIndex: 0,
      turns: [
        {
          turn: 1,
          goalId: "goal-1",
          prompt: "",
          rawResponse: "",
          answer: "",
          toolCalls: [],
          toolResults: [],
          editBlocks: [],
          applyResults: [],
          promptTokens: 100,
          completionTokens: 50,
          timestamp: Date.now(),
        },
      ],
      status: "done" as const,
      scratchpad: "",
      startedAt: Date.now() - 5000,
      updatedAt: Date.now(),
      maxTurns: 15,
    };

    display.showComplete(state);
    const output = chunks.join("");
    expect(output).toContain("1 turn");
  });

  it("showError produces output containing the error message", () => {
    const chunks: string[] = [];
    const fakeStream = {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const display = new ProgressDisplay(fakeStream);
    display.showError("something went wrong");
    const output = chunks.join("");
    expect(output).toContain("something went wrong");
  });

  it("showGoals formats goal list", () => {
    const chunks: string[] = [];
    const fakeStream = {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const display = new ProgressDisplay(fakeStream);
    display.showGoals([
      { id: "goal-1", description: "Read the file", status: "pending" },
      { id: "goal-2", description: "Fix the bug", status: "pending" },
    ]);
    const output = chunks.join("");
    expect(output).toContain("Read the file");
    expect(output).toContain("Fix the bug");
  });

  it("showTurnStart includes turn numbers", () => {
    const chunks: string[] = [];
    const fakeStream = {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const display = new ProgressDisplay(fakeStream);
    display.showTurnStart(3, 15, "Fix the bug");
    const output = chunks.join("");
    expect(output).toContain("3/15");
  });
});

// ---------------------------------------------------------------------------
// configInitCommand tests
// ---------------------------------------------------------------------------

const TMP_DIR = join("/tmp", `smallcode-cli-test-${process.pid}`);

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("configInitCommand", () => {
  it("creates a valid JSON config file", async () => {
    const outputPath = join(TMP_DIR, "new-config.json");

    await configInitCommand({
      command: "config",
      subcommand: "init",
      positionals: [],
      flags: { output: outputPath },
    });

    expect(existsSync(outputPath)).toBe(true);

    const raw = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");

    const cfg = parsed as Record<string, unknown>;
    expect(cfg["config"]).toBeDefined();

    const inner = cfg["config"] as Record<string, unknown>;
    expect(inner["activeModel"]).toBe("qwen2.5-coder:3b");
    expect(inner["maxTurns"]).toBe(15);
    // Out-of-box escalate-on-failure ladder: 3b → 7b (hardware-safe; no 32b assumed).
    expect(inner["escalation"]).toEqual(["qwen2.5-coder:3b", "qwen2.5-coder:7b"]);
  });

  it("uses custom model and endpoint when provided", async () => {
    const outputPath = join(TMP_DIR, "custom-config.json");

    await configInitCommand({
      command: "config",
      subcommand: "init",
      positionals: [],
      flags: {
        output: outputPath,
        model: "qwen2.5-coder:7b",
        endpoint: "http://localhost:8080/v1",
      },
    });

    const raw = readFileSync(outputPath, "utf-8");
    const cfg = JSON.parse(raw) as {
      config: { activeModel: string; provider: { baseUrl: string } };
    };
    expect(cfg.config.activeModel).toBe("qwen2.5-coder:7b");
    expect(cfg.config.provider.baseUrl).toBe("http://localhost:8080/v1");
  });

  it("refuses to overwrite without --force", async () => {
    const outputPath = join(TMP_DIR, "existing-config.json");
    writeFileSync(outputPath, JSON.stringify({ existing: true }), "utf-8");

    // Mock process.exit to avoid killing the test runner
    const originalExit = process.exit.bind(process);
    let exitCode: number | undefined;
    const mockExit = (code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    };
    (process as unknown as Record<string, unknown>)["exit"] = mockExit;

    try {
      await configInitCommand({
        command: "config",
        subcommand: "init",
        positionals: [],
        flags: { output: outputPath },
      });
    } catch (_err) {
      expect(exitCode).toBe(1);
    } finally {
      (process as unknown as Record<string, unknown>)["exit"] = originalExit;
    }

    // File should still have original content
    const content = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(content) as { existing: boolean };
    expect(parsed.existing).toBe(true);
  });

  it("overwrites with --force flag", async () => {
    const outputPath = join(TMP_DIR, "force-config.json");
    writeFileSync(outputPath, JSON.stringify({ old: true }), "utf-8");

    await configInitCommand({
      command: "config",
      subcommand: "init",
      positionals: [],
      flags: { output: outputPath, force: true },
    });

    const raw = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["config"]).toBeDefined();
    expect((parsed["config"] as Record<string, unknown>)["activeModel"]).toBe("qwen2.5-coder:3b");
  });
});

// ---------------------------------------------------------------------------
// configModelsCommand tests
// ---------------------------------------------------------------------------

describe("configModelsCommand", () => {
  it("outputs vibethinker-3b in the list", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = (s: string | Uint8Array) => {
      if (typeof s === "string") chunks.push(s);
      return true;
    };

    try {
      await configModelsCommand();
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = chunks.join("");
    expect(output).toContain("vibethinker-3b");
    expect(output).toContain("qwen2.5-coder:3b");
    expect(output).toContain("qwen2.5-coder:7b");
    expect(output).toContain("qwen2.5-coder-14b");
  });
});
