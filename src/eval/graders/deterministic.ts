import { env } from "@/config/env.ts";
import { repoSubprocessEnv } from "../../util/subprocess-env.ts";
import type { DeterministicTestsGrader, GraderResult } from "../types.ts";

// ---------------------------------------------------------------------------
// Deterministic test grader — runs bun test (or custom command) in trialDir
// ---------------------------------------------------------------------------

/**
 * Parse bun test output to count passes and failures per file.
 * Returns { passed: string[], failed: string[] } of test file names found.
 */
// Infra-error signatures: transient subprocess/toolchain failures (NOT test
// failures). When `bun test` dies on one of these it never ran the tests, so
// recording the trial as a model failure is wrong — we retry instead.
const INFRA_SIGNATURES = [
  "InvalidLockfileVersion",
  "failed to parse lockfile",
  "error: bun.lock",
  "EAGAIN",
  "ETXTBSY",
  "Resource temporarily unavailable",
];

function hasInfraSignature(output: string): boolean {
  return INFRA_SIGNATURES.some((s) => output.includes(s));
}

function parseTestOutput(output: string): { passedFiles: Set<string>; failedFiles: Set<string> } {
  const passedFiles = new Set<string>();
  const failedFiles = new Set<string>();

  // Bun test outputs lines like:
  //   ✓ tests/foo.test.ts
  //   ✗ tests/bar.test.ts
  //   pass tests/foo.test.ts
  //   fail tests/bar.test.ts
  // Also handles summary lines like "1 pass, 0 fail"

  for (const line of output.split("\n")) {
    const trimmed = line.trim();

    // Bun format: "✓ path/to/file.test.ts" or "✗ path/to/file.test.ts"
    const passMatch = trimmed.match(/^[✓✔]\s+(.+\.test\.[tj]sx?)$/);
    if (passMatch?.[1]) {
      passedFiles.add(passMatch[1]);
      continue;
    }

    const failMatch = trimmed.match(/^[✗✘✕×]\s+(.+\.test\.[tj]sx?)$/);
    if (failMatch?.[1]) {
      failedFiles.add(failMatch[1]);
      continue;
    }

    // Alternative: "PASS path/file" or "FAIL path/file" (jest-style)
    const jestPass = trimmed.match(/^PASS\s+(.+\.test\.[tj]sx?)$/i);
    if (jestPass?.[1]) {
      passedFiles.add(jestPass[1]);
      continue;
    }
    const jestFail = trimmed.match(/^FAIL\s+(.+\.test\.[tj]sx?)$/i);
    if (jestFail?.[1]) {
      failedFiles.add(jestFail[1]);
    }
  }

  return { passedFiles, failedFiles };
}

export async function runDeterministicGrader(
  grader: DeterministicTestsGrader,
  trialDir: string,
): Promise<GraderResult> {
  const startMs = Date.now();

  try {
    // Parse command string into argv
    const commandStr = grader.command ?? "bun test";
    const argv = commandStr.trim().split(/\s+/);
    const cmd = argv[0];
    if (!cmd) {
      return {
        type: "deterministic_tests",
        verdict: "error",
        score: 0,
        output: "Empty command",
        durationMs: Date.now() - startMs,
        details: { error: "Empty command" },
      };
    }

    // Bounded retry on transient INFRA errors only. Default 1 retry (2 attempts);
    // override with SMALLCODE_GRADER_RETRIES.
    const maxRetries = env.graderRetries;
    let proc!: ReturnType<typeof Bun.spawnSync>;
    let combined = "";
    let passedFiles = new Set<string>();
    let failedFiles = new Set<string>();
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts = attempt + 1;
      proc = Bun.spawnSync([cmd, ...argv.slice(1)], {
        cwd: trialDir,
        timeout: 60_000,
        stdout: "pipe",
        stderr: "pipe",
        // Don't leak the harness's SMALLCODE_* control vars into the graded repo's
        // own test process (contaminates a smallcode-on-smallcode oracle).
        env: repoSubprocessEnv(),
      });
      const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
      const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
      combined = `${stdout}\n${stderr}`.trim();
      ({ passedFiles, failedFiles } = parseTestOutput(combined));

      // Two-guard retry rule (prevents masking a real failure):
      //  (1) output carries a known INFRA signature, AND
      //  (2) the subprocess produced ZERO test verdicts (no ✓/✗ parsed) — a
      //      genuine failing test always emits a ✗, so failedFiles is non-empty
      //      and we never retry it.
      const isInfra =
        hasInfraSignature(combined) && passedFiles.size === 0 && failedFiles.size === 0;
      if (!isInfra || attempt === maxRetries) break;
      // Small jitter to let the transient (lockfile contention, EAGAIN) clear.
      Bun.sleepSync(100 + Math.floor(Math.random() * 200));
    }

    // Exhausted retries while still infra-erroring → report as an infra error so
    // the run can EXCLUDE this trial from the denominator rather than count it as
    // a model failure.
    if (
      hasInfraSignature(combined) &&
      passedFiles.size === 0 &&
      failedFiles.size === 0
    ) {
      return {
        type: "deterministic_tests",
        verdict: "error",
        score: 0,
        output: combined.length > 2000 ? `${combined.slice(0, 2000)}\n...[truncated]` : combined,
        durationMs: Date.now() - startMs,
        details: { infraError: true, attempts, exitCode: proc.exitCode },
      };
    }

    const truncated =
      combined.length > 2000 ? `${combined.slice(0, 2000)}\n...[truncated]` : combined;

    // If no required files specified, use exit code
    if (grader.required.length === 0) {
      const verdict = proc.exitCode === 0 ? "pass" : "fail";
      return {
        type: "deterministic_tests",
        verdict,
        score: proc.exitCode === 0 ? 1 : 0,
        output: truncated,
        durationMs: Date.now() - startMs,
        details: { exitCode: proc.exitCode },
      };
    }

    // Count required files that passed/failed
    let passCount = 0;
    let failCount = 0;

    for (const required of grader.required) {
      // Match by basename or full path suffix
      const didPass = [...passedFiles].some(
        (f) => f === required || f.endsWith(`/${required}`) || f.endsWith(required),
      );
      const didFail = [...failedFiles].some(
        (f) => f === required || f.endsWith(`/${required}`) || f.endsWith(required),
      );

      if (didPass && !didFail) {
        passCount++;
      } else if (didFail) {
        failCount++;
      } else {
        // Not found in output — use exit code as tie-breaker for single required file
        if (proc.exitCode === 0 && grader.required.length === 1) {
          passCount++;
        } else {
          failCount++;
        }
      }
    }

    const total = grader.required.length;
    const score = total > 0 ? passCount / total : proc.exitCode === 0 ? 1 : 0;

    let verdict: GraderResult["verdict"];
    if (passCount === total) {
      verdict = "pass";
    } else if (passCount === 0) {
      verdict = "fail";
    } else {
      verdict = "partial";
    }

    return {
      type: "deterministic_tests",
      verdict,
      score,
      output: truncated,
      durationMs: Date.now() - startMs,
      details: { passCount, failCount, total, exitCode: proc.exitCode },
    };
  } catch (err) {
    return {
      type: "deterministic_tests",
      verdict: "error",
      score: 0,
      output: String(err),
      durationMs: Date.now() - startMs,
      details: { error: String(err) },
    };
  }
}
