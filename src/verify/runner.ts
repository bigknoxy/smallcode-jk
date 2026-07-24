import { repoSubprocessEnv } from "../util/subprocess-env.ts";
import type { CheckerConfig, CheckResult, VerifyConfig, VerifyResult } from "./types.ts";

const MAX_OUTPUT_CHARS = 4000;
const MAX_SUMMARY_CHARS = 200;

export async function runChecker(checker: CheckerConfig, repoRoot: string): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = Bun.spawnSync(checker.command, {
      cwd: checker.cwd ?? repoRoot,
      timeout: checker.timeoutMs ?? 30_000,
      env: repoSubprocessEnv(),
    });

    const stdout =
      result.stdout instanceof Uint8Array
        ? new TextDecoder().decode(result.stdout)
        : String(result.stdout ?? "");
    const stderr =
      result.stderr instanceof Uint8Array
        ? new TextDecoder().decode(result.stderr)
        : String(result.stderr ?? "");
    const combined = (stdout + stderr).slice(0, MAX_OUTPUT_CHARS);
    const exitCode = result.exitCode ?? 1;

    return {
      kind: checker.kind,
      name: checker.name,
      status: exitCode === 0 ? "passed" : "failed",
      output: combined,
      durationMs: Date.now() - start,
      exitCode,
    };
  } catch (err) {
    return {
      kind: checker.kind,
      name: checker.name,
      status: "error",
      output:
        err instanceof Error
          ? err.message.slice(0, MAX_OUTPUT_CHARS)
          : String(err).slice(0, MAX_OUTPUT_CHARS),
      durationMs: Date.now() - start,
      exitCode: -1,
    };
  }
}

export async function runAllCheckers(config: VerifyConfig): Promise<VerifyResult> {
  const wallStart = Date.now();

  const checks = await Promise.all(
    config.checkers
      .filter((c) => c.enabled !== false)
      .map((checker) => runChecker(checker, config.repoRoot)),
  );

  const nonSkipped = checks.filter((c) => c.status !== "skipped");
  const passed = checks.filter((c) => c.status === "passed");
  const failures = checks.filter((c) => c.status === "failed" || c.status === "error");

  const failureSummary = failures
    .map((c) => `[${c.kind}] ${c.name}: ${c.output.slice(0, MAX_SUMMARY_CHARS)}`)
    .join("\n");

  return {
    checks,
    passed: failures.length === 0 && nonSkipped.length > 0,
    checksRun: nonSkipped.length,
    checksPassed: passed.length,
    failureSummary,
    totalDurationMs: Date.now() - wallStart,
  };
}
