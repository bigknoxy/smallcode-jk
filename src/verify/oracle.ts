import { extractFirstFailure, type FailureDiagnostic } from "./failure-extract.ts";
import { runChecker } from "./runner.ts";
import type { CheckerConfig, CheckResult } from "./types.ts";

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
  /** Failing test IDs introduced since the baseline (baseline fix). */
  newFailures?: string[];
  /** Failing test IDs that were already failing at baseline capture time. */
  baselineFailures?: string[];
  /** Structured diagnostic for the first failing assertion (set on failing paths). */
  diagnostic?: FailureDiagnostic;
}

/**
 * Parse `bun test` output into a set of failing-test identifiers.
 *
 * Bun prints each failing test as:
 *   (fail) <label> [12ms]
 *
 * The label is either a bare test name or a "describe > name" path.
 * We strip the trailing `[…ms]` timing suffix so IDs are stable across runs.
 *
 * Exported for unit testing.
 */
export function parseFailingTestIds(output: string): Set<string> {
  // Fix 5: strip ANSI escapes for robustness against colored output
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI strip
  const cleaned = output.replace(/\x1b\[[0-9;]*m/g, "");
  const ids = new Set<string>();
  // Match: (fail) <label> [optional [<digits>ms]]  (with optional leading whitespace)
  // Also handle the ✗ marker variant some Bun versions emit.
  // Timing suffix is optional because Bun sometimes omits it under high concurrency.
  const re = /^\s*(?:\(fail\)|✗)\s+(.+?)(?:\s+\[\d+(?:\.\d+)?ms\])?\s*$/gm;
  for (const m of cleaned.matchAll(re)) {
    const label = (m[1] ?? "").trim();
    if (label) ids.add(label);
  }
  return ids;
}

export interface TestBaseline {
  failingIds: Set<string>;
  hadAnyTests: boolean;
  /**
   * Total red count at baseline = `N fail` + `N error` from bun's summary.
   * Not every failure prints a parseable `(fail) <name>` line — module-load
   * errors and unhandled throws show only in the summary counts. Tracking the
   * count lets us catch agent-introduced failures the id-parser can't see,
   * so a new crash can never be mistaken for "solved".
   */
  redCount: number;
}

/** Parse bun's summary red count: `N fail` + `N error`. Exported for testing. */
export function parseRedCount(output: string): number {
  return num(output.match(/(\d+)\s+fail/i)) + num(output.match(/(\d+)\s+error/i));
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

export function captureTestBaseline(repoRoot: string): TestBaseline {
  const { state, result } = runBunTest(repoRoot);
  return {
    failingIds: parseFailingTestIds(result.output),
    hadAnyTests: state !== "absent",
    redCount: parseRedCount(result.output),
  };
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
  /**
   * Pre-loop baseline snapshot. "solved" always requires a fully green suite;
   * the baseline does NOT relax that bar. It is used only to shape feedback —
   * separating failures the agent newly introduced (`newFailures`, the count
   * guard) from tests that were already red at baseline — so the model gets a
   * focused next-turn message instead of the whole suite output.
   */
  baseline?: TestBaseline;
}

export async function runTieredOracle(
  repoRoot: string,
  opts: TieredOracleOptions = {},
): Promise<OracleVerdict> {
  // Tier 1: tests (authoritative).
  const test = runBunTest(repoRoot);
  if (test.state !== "absent") {
    const baselineFailing: Set<string> = opts.baseline?.failingIds ?? new Set();
    const currentFailing = parseFailingTestIds(test.result.output);
    const newFailures = [...currentFailing].filter((id) => !baselineFailing.has(id));
    const passCount = num(test.result.output.match(/(\d+)\s+pass/i));

    const baselineRed = opts.baseline?.redCount ?? 0;
    const currentRed = parseRedCount(test.result.output);
    const countRegression = currentRed > baselineRed;

    // Honesty rule: "solved" requires a FULLY GREEN suite (zero failures, ≥1
    // pass). The earlier baseline-relative rule ("no NEW failures + something
    // passes") falsely reported solved whenever the task targeted a test that
    // was already failing at baseline and the edit never landed — the target
    // stayed red while unrelated tests passed. The success tick must never show
    // while ANY test is red, so anything short of green is reported as failing
    // and the loop keeps working. The baseline below only shapes FEEDBACK (new
    // breakage vs pre-existing reds); it no longer relaxes the done bar. A repo
    // with genuinely unrelated, unfixable reds therefore ends in max_turns —
    // the honest outcome, not a false "verified passing".
    if (currentRed === 0 && passCount >= 1) {
      return {
        outcome: "solved",
        checks: [test.result],
        feedback: "",
        newFailures: [],
        baselineFailures: [...baselineFailing],
      };
    }

    // Build focused feedback: lead with new failures, then pre-existing reds.
    const stalledOnBaseline = newFailures.length === 0 && !countRegression;
    const feedbackBody =
      newFailures.length > 0
        ? `New failures:\n${newFailures.join("\n")}\n\n${test.result.output.slice(0, MAX_FEEDBACK)}`
        : countRegression
          ? `New failure(s) introduced (${currentRed - baselineRed} more than before):\n${test.result.output.slice(0, MAX_FEEDBACK)}`
          : stalledOnBaseline
            ? `The pre-existing failing test(s) are STILL failing — your change did not fix the target. Check it edited the right file.\n\n${test.result.output.slice(0, MAX_FEEDBACK)}`
            : test.result.output.slice(0, MAX_FEEDBACK);

    return {
      outcome: "failing",
      checks: [test.result],
      feedback: `Tests failing:\n${feedbackBody}`,
      newFailures,
      baselineFailures: [...baselineFailing],
      diagnostic: extractFirstFailure(test.result.output) ?? undefined,
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
        diagnostic: extractFirstFailure(tsc.output) ?? undefined,
      };
    }
  }

  // No tests covered the change and nothing concrete failed.
  return { outcome: "clean", checks, feedback: "" };
}
