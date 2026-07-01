import { env } from "@/config/env.ts";
import { computeStaticConfidence, type StaticConfidence } from "./confidence.ts";
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
  /**
   * True when this turn's edit REGRESSED the suite relative to baseline — either
   * parseable new `(fail)` lines (`newFailures` non-empty) OR a count regression
   * (more red than baseline) with NO parseable lines, e.g. a crash/module-load
   * error that prints only in bun's summary counts. The loop reverts on this flag
   * (not on `newFailures.length` alone), so a crash-regression is rolled back too.
   */
  regressed?: boolean;
  /** Failing test IDs that were already failing at baseline capture time. */
  baselineFailures?: string[];
  /** Structured diagnostic for the first failing assertion (set on failing paths). */
  diagnostic?: FailureDiagnostic;
  /**
   * Oracle-free path only: when the outcome is "clean" (no test covered the
   * change), a deterministic static-confidence grade (typecheck + lint) so the
   * caller can report honestly what WAS checked instead of a bare "unverified".
   * A safety signal, not a correctness one — never set when tests verified.
   */
  confidence?: StaticConfidence;
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
  /**
   * R4: did the suite already fail to LOAD/COMPILE at baseline? If so, an edit
   * that also fails to load is NOT a new regression (the repo was broken before
   * the agent touched it), so the load-error guard must not fire.
   */
  loadError: boolean;
}

/** Parse bun's summary red count: `N fail` + `N error`. Exported for testing. */
export function parseRedCount(output: string): number {
  return num(output.match(/(\d+)\s+fail/i)) + num(output.match(/(\d+)\s+error/i));
}

/**
 * R4 validate-before-commit. True when the suite failed to LOAD/COMPILE rather
 * than merely failing assertions — a missing module, a transpile/parse error, an
 * unhandled error before any test ran. These matter because a non-loading suite
 * runs FEWER tests, so its red-count DROPS below baseline and the count-regression
 * guard mistakes a broken edit for progress (the dogfood `std/strings` failure:
 * baseline 4 red → broken 2 red → "improved", edit kept, repo left non-loading).
 * Detecting it lets the loop treat an introduced load error as a hard regression
 * regardless of count. Conservative signatures only — never a normal assertion.
 * Exported for testing.
 */
export function hasLoadError(output: string): boolean {
  const cleaned = output.replace(/\x1b\[[0-9;]*m/g, "");
  return /Cannot find (?:module|package)|error: Cannot find|SyntaxError|Transpilation failed|Parse error|Unhandled error between tests|error: Expected (?:";"|expression|"\)")/i.test(
    cleaned,
  );
}

/**
 * R4 master switch. ON by default — keeping a non-compiling edit is never correct.
 * Set SMALLCODE_VALIDATE_EDIT=0 to restore the old count-only behaviour (used as
 * the baseline arm of the R4 A/B).
 */
const VALIDATE_EDIT = env.validateEdit;

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

/**
 * Oracle-free safety guard. A "clean" verdict (no test covered the change) whose
 * static confidence is "broken" means the edit does not even PARSE — accepting it
 * leaves the repo non-compiling though no test flagged it. Promote it to a
 * failing+regressed verdict so the loop's revert-on-regression + BUILD ERROR
 * prompt + stall machinery fire (the R4 load-error treatment, generalized to
 * untested repos). Pure; a no-op for any other verdict. Exported for testing.
 */
export function escalateBrokenClean(verdict: OracleVerdict): OracleVerdict {
  if (verdict.outcome !== "clean" || verdict.confidence?.level !== "broken") return verdict;
  const parseErr =
    verdict.confidence.signals.find((s) => s.startsWith("parse error")) ?? "a source file does not parse";
  return {
    ...verdict,
    outcome: "failing",
    regressed: true,
    feedback: `BUILD ERROR — your edit does not parse, so nothing ran. ${parseErr}. Fix the syntax: balance brackets/quotes and remove stray tokens.`,
    newFailures: ["<parse error: your edit does not compile>"],
    diagnostic: { assertionId: "<parse-error>", message: parseErr, errorType: "SyntaxError", raw: parseErr },
  };
}

export function captureTestBaseline(repoRoot: string): TestBaseline {
  const { state, result } = runBunTest(repoRoot);
  return {
    failingIds: parseFailingTestIds(result.output),
    hadAnyTests: state !== "absent",
    redCount: parseRedCount(result.output),
    loadError: hasLoadError(result.output),
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

    // A regression is EITHER parseable new failures OR a count regression with no
    // parseable `(fail)` lines (a crash/module-load error shows only in bun's
    // summary counts). Surface a synthetic newFailures entry in the latter case so
    // the model-facing list — and the loop's ⚠ revert warning — is informative.
    // R4: an INTRODUCED load/compile error is a hard regression even when the
    // red-count fell (a non-loading suite runs fewer tests). Without this the
    // count guard reads "fewer reds = progress" and keeps a broken edit.
    const introducedLoadError =
      VALIDATE_EDIT && hasLoadError(test.result.output) && opts.baseline?.loadError !== true;

    const reportedFailures = [...newFailures];
    if (introducedLoadError && newFailures.length === 0) {
      reportedFailures.push("<build error: your last edit does not compile/load — the suite never ran>");
    } else if (countRegression && newFailures.length === 0) {
      reportedFailures.push(
        `<unparseable failure: ${currentRed - baselineRed} more test(s) red than baseline>`,
      );
    }
    const regressed = newFailures.length > 0 || countRegression || introducedLoadError;

    // Build focused feedback: lead with build errors, then new failures, then
    // pre-existing reds. R4 build error is checked FIRST — it's the most
    // actionable signal and a non-loading suite makes the count-based messages
    // misleading.
    const stalledOnBaseline = newFailures.length === 0 && !countRegression && !introducedLoadError;
    const feedbackBody = introducedLoadError
      ? `BUILD ERROR — your last edit does not compile/load, so the test suite never ran. Fix the import/syntax (do NOT import modules that don't exist; use built-in JS/TS APIs):\n\n${test.result.output.slice(0, MAX_FEEDBACK)}`
      : newFailures.length > 0
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
      newFailures: reportedFailures,
      baselineFailures: [...baselineFailing],
      regressed,
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

  let tcResult: CheckResult | undefined;
  if (typecheck) {
    const tsc = await runChecker(typecheck, repoRoot);
    const real = tsc.status === "failed" && tscHasRealErrors(tsc.output);
    // Demote config/setup noise and tool-missing errors to "skipped".
    if (!real) tsc.status = tsc.status === "passed" ? "passed" : "skipped";
    checks.push(tsc);
    tcResult = tsc;
    if (real) {
      return {
        outcome: "failing",
        checks,
        feedback: `Type errors:\n${tsc.output.slice(0, MAX_FEEDBACK)}`,
        diagnostic: extractFirstFailure(tsc.output) ?? undefined,
      };
    }
  }

  // Oracle-free path: no test covered the change and nothing concrete failed. We
  // cannot claim correctness, so instead of a bare "clean" we attach a
  // deterministic static-confidence (typecheck + lint) the caller can report
  // honestly. Gate the (extra lint) work behind an env flag, default ON — it only
  // fires when tests are ABSENT, never on a test-backed turn.
  const confidence = env.staticConfidence
    ? await computeStaticConfidence(repoRoot, tcResult)
    : undefined;
  return { outcome: "clean", checks, feedback: "", confidence };
}
