import { describe, expect, it } from "bun:test";
import { defaultCheckers, defaultVerifyConfig } from "@/verify/defaults.ts";
import { formatVerifyFeedback } from "@/verify/feedback.ts";
import { runAllCheckers, runChecker } from "@/verify/runner.ts";
import type { CheckerConfig, VerifyResult } from "@/verify/types.ts";

const REPO_ROOT = import.meta.dir.replace(/\/tests$/, "");

// ── 1. defaultCheckers returns 3 checkers with correct kinds ─────────────────
describe("defaultCheckers", () => {
  it("returns 3 checkers with correct kinds", () => {
    const checkers = defaultCheckers(REPO_ROOT);
    expect(checkers).toHaveLength(3);
    expect(checkers[0]?.kind).toBe("format");
    expect(checkers[1]?.kind).toBe("typecheck");
    expect(checkers[2]?.kind).toBe("test");
  });
});

// ── 2. defaultVerifyConfig sets maxCorrectionIterations to 3 ─────────────────
describe("defaultVerifyConfig", () => {
  it("sets maxCorrectionIterations to 3", () => {
    const config = defaultVerifyConfig(REPO_ROOT);
    expect(config.maxCorrectionIterations).toBe(3);
    expect(config.repoRoot).toBe(REPO_ROOT);
  });
});

// ── 3. runChecker with passing command ───────────────────────────────────────
describe("runChecker", () => {
  it("returns status 'passed' for bun --version", async () => {
    const checker: CheckerConfig = {
      kind: "custom",
      name: "bun-version",
      command: ["bun", "--version"],
      timeoutMs: 10_000,
    };
    const result = await runChecker(checker, REPO_ROOT);
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.name).toBe("bun-version");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── 4. runChecker with failing command ──────────────────────────────────
  it("returns status 'failed' for nonexistent bun script", async () => {
    const checker: CheckerConfig = {
      kind: "test",
      name: "bad-script",
      command: ["bun", "run", "nonexistent-script-xyz"],
      timeoutMs: 10_000,
    };
    const result = await runChecker(checker, REPO_ROOT);
    expect(result.status).toBe("failed");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── 5. runAllCheckers with all-passing checkers ───────────────────────────────
describe("runAllCheckers", () => {
  it("returns passed=true when all checkers pass", async () => {
    const config = {
      repoRoot: REPO_ROOT,
      maxCorrectionIterations: 3,
      checkers: [
        {
          kind: "custom" as const,
          name: "pass-1",
          command: ["bun", "--version"],
          timeoutMs: 10_000,
        },
        {
          kind: "custom" as const,
          name: "pass-2",
          command: ["bun", "--version"],
          timeoutMs: 10_000,
        },
      ],
    };
    const result = await runAllCheckers(config);
    expect(result.passed).toBe(true);
    expect(result.checksPassed).toBe(result.checksRun);
    expect(result.checksRun).toBe(2);
  });

  // ── 6. runAllCheckers with one failing checker ────────────────────────
  it("returns passed=false when any checker fails", async () => {
    const config = {
      repoRoot: REPO_ROOT,
      maxCorrectionIterations: 3,
      checkers: [
        {
          kind: "custom" as const,
          name: "pass-1",
          command: ["bun", "--version"],
          timeoutMs: 10_000,
        },
        {
          kind: "test" as const,
          name: "fail-1",
          command: ["bun", "run", "nonexistent-script-xyz"],
          timeoutMs: 10_000,
        },
      ],
    };
    const result = await runAllCheckers(config);
    expect(result.passed).toBe(false);
    expect(result.checksPassed).toBeLessThan(result.checksRun);
  });
});

// ── 7. formatVerifyFeedback with passed result ────────────────────────────────
describe("formatVerifyFeedback", () => {
  const passedResult: VerifyResult = {
    checks: [
      {
        kind: "format",
        name: "biome-format",
        status: "passed",
        output: "",
        durationMs: 10,
        exitCode: 0,
      },
    ],
    passed: true,
    checksRun: 1,
    checksPassed: 1,
    failureSummary: "",
    totalDurationMs: 10,
  };

  it("returns 'All checks passed' message when result is passed", () => {
    const feedback = formatVerifyFeedback(passedResult, 1, 3);
    expect(feedback).toMatch(/all checks passed/i);
  });

  // ── 8. formatVerifyFeedback with failed typecheck ─────────────────────
  it("contains [typecheck] and checker name for failed typecheck", () => {
    const failedResult: VerifyResult = {
      checks: [
        {
          kind: "typecheck",
          name: "tsc",
          status: "failed",
          output:
            "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
          durationMs: 500,
          exitCode: 1,
        },
      ],
      passed: false,
      checksRun: 1,
      checksPassed: 0,
      failureSummary: "[typecheck] tsc: src/foo.ts(12,5): error TS2322",
      totalDurationMs: 500,
    };
    const feedback = formatVerifyFeedback(failedResult, 1, 3);
    expect(feedback).toContain("[typecheck]");
    expect(feedback).toContain("tsc");
    expect(feedback).toContain("TS2322");
  });

  // ── 9. formatVerifyFeedback at max iteration ──────────────────────────
  it("contains 'LAST attempt' at max iteration", () => {
    const failedResult: VerifyResult = {
      checks: [
        {
          kind: "test",
          name: "bun-test",
          status: "failed",
          output: "1 fail",
          durationMs: 100,
          exitCode: 1,
        },
      ],
      passed: false,
      checksRun: 1,
      checksPassed: 0,
      failureSummary: "[test] bun-test: 1 fail",
      totalDurationMs: 100,
    };
    const feedback = formatVerifyFeedback(failedResult, 3, 3);
    expect(feedback).toContain("LAST attempt");
  });
});

// ── 10. failureSummary lists only failing checkers ────────────────────────────
describe("failureSummary", () => {
  it("lists only failing checkers, not passing ones", async () => {
    const config = {
      repoRoot: REPO_ROOT,
      maxCorrectionIterations: 3,
      checkers: [
        {
          kind: "custom" as const,
          name: "pass-check",
          command: ["bun", "--version"],
          timeoutMs: 10_000,
        },
        {
          kind: "test" as const,
          name: "fail-check",
          command: ["bun", "run", "nonexistent-script-xyz"],
          timeoutMs: 10_000,
        },
      ],
    };
    const result = await runAllCheckers(config);
    expect(result.failureSummary).toContain("fail-check");
    expect(result.failureSummary).not.toContain("pass-check");
  });
});
