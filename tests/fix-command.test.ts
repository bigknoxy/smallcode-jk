/**
 * Tests for `smallcode fix` — the test-driven auto-fix / pre-commit primitive.
 * Model-free: exercises the green-repo short-circuit (no agent loop invoked),
 * the red-output → task-string builder, and arg parsing. Driving the RED→fix
 * loop for real needs a model, which is out of scope here (see run/loop tests).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { buildFixTask, fixCommand, runTestCommand } from "../src/cli/commands/fix.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fix-cmd-"));
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// parseArgs — "fix" command
// ---------------------------------------------------------------------------

describe("parseArgs — fix command", () => {
  it("parses --repo/--test/--json flags", () => {
    const result = parseArgs(["fix", "--repo", "/p", "--test", "bun test", "--json"]);
    expect(result.command).toBe("fix");
    expect(result.flags["repo"]).toBe("/p");
    expect(result.flags["test"]).toBe("bun test");
    expect(result.flags["json"]).toBe(true);
  });

  it("parses --model/--best-of-n/--escalation/--max-turns", () => {
    const result = parseArgs([
      "fix",
      "--model",
      "qwen2.5-coder:3b",
      "--best-of-n",
      "3",
      "--escalation",
      "m1,m2",
      "--max-turns",
      "10",
    ]);
    expect(result.command).toBe("fix");
    expect(result.flags["model"]).toBe("qwen2.5-coder:3b");
    expect(result.flags["best-of-n"]).toBe("3");
    expect(result.flags["escalation"]).toBe("m1,m2");
    expect(result.flags["max-turns"]).toBe("10");
  });

  it("defaults to no flags with bare `fix`", () => {
    const result = parseArgs(["fix"]);
    expect(result.command).toBe("fix");
    expect(result.positionals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildFixTask — pure task-string builder
// ---------------------------------------------------------------------------

describe("buildFixTask", () => {
  it("embeds the failing output and instructs not to edit tests", () => {
    const task = buildFixTask("FAIL tests/a.test.ts\n1 fail, 2 pass");
    expect(task).toContain("The test suite is failing");
    expect(task).toContain("without editing the tests");
    expect(task).toContain("FAIL tests/a.test.ts");
  });

  it("truncates very long output", () => {
    const longOutput = "x".repeat(10000);
    const task = buildFixTask(longOutput);
    expect(task.length).toBeLessThan(longOutput.length);
    expect(task).toContain("(truncated)");
  });
});

// ---------------------------------------------------------------------------
// runTestCommand — real process spawn, deterministic exit codes
// ---------------------------------------------------------------------------

describe("runTestCommand", () => {
  it("ok=true for an exit-0 command", async () => {
    const dir = await tmpRepo();
    const result = runTestCommand("true", dir);
    expect(result.ok).toBe(true);
  });

  it("ok=false + captured output for a failing command", async () => {
    const dir = await tmpRepo();
    // `bun -e` runs an inline script; exit non-zero with stderr output.
    const result = runTestCommand("bun -e \"console.error('boom'); process.exit(1)\"", dir);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// fixCommand — already-green repo short-circuits WITHOUT invoking the agent loop
// ---------------------------------------------------------------------------

describe("fixCommand — already-green repo", () => {
  it("exits 0 and reports 'nothing to fix' without running the agent loop", async () => {
    const dir = await tmpRepo();
    // No agent/provider imports are exercised here — if the loop were invoked it
    // would attempt to load config / hit a model endpoint and this test would
    // hang or throw. A clean pass with `--test true` proves the short-circuit.
    const originalWrite = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = ((s: string | Uint8Array) => {
      if (typeof s === "string") chunks.push(s);
      return true;
    }) as typeof process.stdout.write;

    try {
      await fixCommand({
        command: "fix",
        positionals: [],
        flags: { repo: dir, test: "true" },
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = chunks.join("");
    expect(output).toContain("nothing to fix");
  });

  it("--json reports {ok:true, reason:'already green'} without running the agent loop", async () => {
    const dir = await tmpRepo();
    const originalWrite = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = ((s: string | Uint8Array) => {
      if (typeof s === "string") chunks.push(s);
      return true;
    }) as typeof process.stdout.write;

    try {
      await fixCommand({
        command: "fix",
        positionals: [],
        flags: { repo: dir, test: "true", json: true },
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = chunks.join("").trim();
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(true);
    expect(parsed["reason"]).toBe("already green");
  });
});
