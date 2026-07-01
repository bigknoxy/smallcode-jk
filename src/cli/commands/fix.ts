import { resolve } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { runCommand } from "./run.ts";

// ---------------------------------------------------------------------------
// smallcode fix — the test-driven auto-fix / pre-commit / delegation primitive.
//
// Mechanism: run the test command. If GREEN, there's nothing to do — report and
// exit 0 WITHOUT ever invoking the agent loop. If RED, build a task string from
// the captured failing output and delegate to `runCommand` with that task as the
// synthetic positional — this reuses `run`'s ENTIRE pipeline (config/provider/
// registry/loop/BoN/escalation/--json output) with zero duplication. `fix` is
// just "run, but the task is auto-derived from a failing test suite instead of
// typed by a human".
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 4000;

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

export interface TestRunResult {
  ok: boolean;
  output: string;
}

/** Run the test command in `repo`, capturing combined stdout+stderr. Exported for tests. */
export function runTestCommand(cmd: string, repo: string): TestRunResult {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  const [bin, ...rest] = parts;
  if (!bin) return { ok: true, output: "" };
  const p = Bun.spawnSync([bin, ...rest], { cwd: repo });
  const out =
    (p.stdout instanceof Uint8Array ? new TextDecoder().decode(p.stdout) : "") +
    (p.stderr instanceof Uint8Array ? new TextDecoder().decode(p.stderr) : "");
  return { ok: (p.exitCode ?? 1) === 0, output: out };
}

/** Build the auto-fix task string from captured RED test output. Pure; exported for tests. */
export function buildFixTask(redOutput: string): string {
  const trimmed = redOutput.trim();
  const truncated =
    trimmed.length > MAX_OUTPUT_CHARS
      ? `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
      : trimmed;
  return `The test suite is failing. Make the failing tests pass without editing the tests. Failing output:\n${truncated}`;
}

/** `smallcode fix` — test-driven auto-fix. See module doc above. */
export async function fixCommand(args: ParsedArgs): Promise<void> {
  const repo = resolve(flagString(args.flags, "repo") ?? process.cwd());
  const testCmd = flagString(args.flags, "test") ?? "bun test";
  const jsonMode = flagBool(args.flags, "json");
  const modelId = flagString(args.flags, "model") ?? "";

  process.stderr.write(`[smallcode] fix: running "${testCmd}" in ${repo}...\n`);
  const result = runTestCommand(testCmd, repo);

  if (result.ok) {
    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          verified: true,
          status: "already_green",
          model: modelId,
          turnsUsed: 0,
          filesChanged: [],
          added: 0,
          removed: 0,
          reason: "already green",
        })}\n`,
      );
    } else {
      process.stdout.write("[smallcode] nothing to fix (tests already pass)\n");
    }
    return;
  }

  process.stderr.write(
    "[smallcode] fix: tests are RED — deriving a fix task from the failing output.\n",
  );
  const task = buildFixTask(result.output);

  // Delegate to run's ENTIRE pipeline. Same flags flow through unchanged (--repo,
  // --model, --best-of-n, --escalation, --max-turns, --json, --config); run.ts
  // ignores the --test flag it doesn't know about.
  const runArgs: ParsedArgs = {
    command: "run",
    positionals: [task],
    flags: args.flags,
  };
  await runCommand(runArgs);
}
