import { runChecker } from "./runner.ts";
import type { CheckResult, CheckerConfig } from "./types.ts";

/**
 * Tiered verification oracle.
 *
 * The agent's early-stop signal was previously a single `bun test`: green = done.
 * That only works when the task is covered by a runnable test. Real repos often
 * have NO test for the thing being changed (a new feature, a refactor), leaving
 * the loop with zero verification signal. This oracle tiers the available checks
 * so the agent always gets *some* ground-truth feedback:
 *
 *   Tier 1  tests   — authoritative. Green (≥1 pass, 0 fail) ⇒ SOLVED (proven).
 *                     Red (≥1 fail)  ⇒ FAILING, with the failing output as feedback.
 *                     Absent (no test files) ⇒ fall through, NOT a failure.
 *   Tier 2  typecheck — advisory. Only counts as a failure when it emits real
 *                     `error TS####` diagnostics (so a missing/!misconfigured
 *                     tsconfig degrades to "skipped" instead of false-failing).
 *
 * Outcomes:
 *   "solved"  — tests passed. Definitive; the loop early-stops.
 *   "clean"   — no test covers this, but nothing failed. Plausible-but-unproven;
 *               the loop accepts it only when the model calls `finish`.
 *   "failing" — something concrete failed; `feedback` is fed to the next turn.
 *
 * Tiers short-circuit: if tests are green, typecheck is not run (no noise, no
 * wasted time). This keeps test-covered tasks — and the benchmark — unchanged.
 */
export type OracleOutcome = "solved" | "clean" | "failing";

export interface OracleVerdict {
  outcome: OracleOutcome;
  checks: CheckResult[];
  /** Model-facing summary of what failed (empty when solved/clean). */
  feedback: string;
}

export type TestState = "green" | "red" | "absent";

const MAX_FEEDBACK = 1500;

function num(m: RegExpMatchArray | null): number {
  return m ? parseInt(m[1] ?? "0", 10) : 0;
}

/** Classify `bun test` output. Exported for unit testing. */
export function classifyTest(output: string, exitCode: number): TestState {
  const pass = num(output.match(/(\d+)\s+pass/i));
  const fail = num(output.match(/(\d+)\s+fail/i));
  if (fail > 0) return "red";
  if (pass > 0 && exitCode === 0) return "green";
  // No pass, no fail — bun exits non-zero when it finds no test files.
  return "absent";
}

/**
 * Does tsc output contain real type-error diagnostics? A missing/broken tsconfig
 * yields config errors (TS5xxx / "Cannot find") that we do NOT want to treat as a
 * task failure. Exported for unit testing.
 */
export function tscHasRealErrors(output: string): boolean {
  // Real code diagnostics look like "file.ts(12,3): error TS2322: ...".
  // Config/setup failures (TS5023/TS5057/TS6053 "Cannot find") are not the
  // model's fault and shouldn't block.
  const diagnostics = [...output.matchAll(/error TS(\d{3,4}):/g)].map((m) => m[1] ?? "");
  if (diagnostics.length === 0) return false;
  const configCodes = new Set(["5023", "5057", "5058", "6053", "18003"]);
  return diagnostics.some((code) => !configCodes.has(code));
}

function runBunTest(repoRoot: string): { state: TestState; result: CheckResult } {
  const start = Date.now();
  const proc = Bun.spawnSync(["bun", "test"], { cwd: repoRoot, timeout: 120_000 });
  const out =
    (proc.stdout instanceof Uint8Array ? new TextDecoder().decode(proc.stdout) : "") +
    (proc.stderr instanceof Uint8Array ? new TextDecoder().decode(proc.stderr) : "");
  const exit = proc.exitCode ?? 1;
  const state = classifyTest(out, exit);
  return {
    state,
    result: {
      kind: "test",
      name: "bun-test",
      status: state === "green" ? "passed" : state === "red" ? "failed" : "skipped",
      output: out.slice(0, 4000),
      durationMs: Date.now() - start,
      exitCode: exit,
    },
  };
}

export interface TieredOracleOptions {
  /** Override the typecheck checker (e.g. to disable, or point elsewhere). */
  typecheck?: CheckerConfig | null;
}

export async function runTieredOracle(
  repoRoot: string,
  opts: TieredOracleOptions = {},
): Promise<OracleVerdict> {
  // Tier 1: tests (authoritative).
  const test = runBunTest(repoRoot);
  if (test.state === "green") {
    return { outcome: "solved", checks: [test.result], feedback: "" };
  }
  if (test.state === "red") {
    return {
      outcome: "failing",
      checks: [test.result],
      feedback: `Tests failing:\n${test.result.output.slice(0, MAX_FEEDBACK)}`,
    };
  }

  // Tests absent → Tier 2: typecheck (advisory, real-errors-only).
  const checks: CheckResult[] = [test.result];
  const typecheck =
    opts.typecheck === undefined
      ? {
          kind: "typecheck" as const,
          name: "tsc",
          command: ["bunx", "tsc", "--noEmit"],
          cwd: repoRoot,
          timeoutMs: 60_000,
        }
      : opts.typecheck;

  if (typecheck) {
    const tsc = await runChecker(typecheck, repoRoot);
    const real = tsc.status === "failed" && tscHasRealErrors(tsc.output);
    // Demote config/setup noise and tool-missing errors to "skipped".
    if (!real) tsc.status = tsc.status === "passed" ? "passed" : "skipped";
    checks.push(tsc);
    if (real) {
      return {
        outcome: "failing",
        checks,
        feedback: `Type errors:\n${tsc.output.slice(0, MAX_FEEDBACK)}`,
      };
    }
  }

  // No tests covered the change and nothing concrete failed.
  return { outcome: "clean", checks, feedback: "" };
}
