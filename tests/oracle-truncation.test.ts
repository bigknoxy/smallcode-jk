import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import {
  __setBunTestRunnerForTests,
  captureTestBaseline,
  classifyTest,
  finalStateWorseThanBaseline,
  parseFailingTestIds,
  parseRedCount,
  runTieredOracle,
} from "../src/verify/oracle.ts";

/**
 * Regression guard for the truncation bug that silently disabled the final-state
 * regression guard (and the per-turn revert): the verdict parsers read a
 * `bun test` output that had been sliced to 4000 chars for model-facing
 * feedback. A verbose failure (deep recursion / long stack traces) pushed the
 * `(fail)` markers and the `X pass / Y fail` summary past that cutoff, so the
 * parser read a false "0 red" and the guard concluded the repo was "not worse".
 * The fix routes the full, un-truncated output to `parseRedCount` /
 * `parseFailingTestIds` / `hasLoadError` in `captureTestBaseline` and
 * `runTieredOracle`, slicing only for the model-facing feedback string.
 *
 * These are pure/deterministic (no nested `bun test` subprocess) so they can
 * never flake under the outer runner's concurrency.
 */
describe("oracle output-truncation regression", () => {
  it("the parsers read the WHOLE output — a summary past the feedback slice is not lost", () => {
    // The real failure mode: 25k+ chars of recursion stack frames push the
    // summary past char 4000. The full parse must still see the reds; a
    // truncated parse (the bug) reads zero.
    const noise = "at applySearchReplace (applier.ts:329:20)\n".repeat(400); // ~16 KB
    const failLines = Array.from(
      { length: 15 },
      (_, i) => `(fail) verbose failure ${i} [0.1ms]`,
    ).join("\n");
    const longOut = `${failLines}\n${noise}\n 1 pass\n 15 fail\n Ran 16 tests across 1 file.\n`;
    expect(longOut.length).toBeGreaterThan(4000);

    expect(parseRedCount(longOut)).toBe(15);
    expect(parseFailingTestIds(longOut).size).toBe(15);
    // The bug: parsing only the first 4000 chars loses the summary → false 0.
    expect(parseRedCount(longOut.slice(0, 4000))).toBe(0);
  });

  it("finalStateWorseThanBaseline flags a real count regression", () => {
    const base = { failingIds: new Set(["a", "b"]), hadAnyTests: true, redCount: 2, loadError: false };
    const worse = { failingIds: new Set(["a", "b", "c", "d"]), hadAnyTests: true, redCount: 4, loadError: false };
    expect(finalStateWorseThanBaseline(base, worse).worse).toBe(true);
    expect(finalStateWorseThanBaseline(base, base).worse).toBe(false);
  });
});

/**
 * End-to-end guard: drive the FULL oracle entry points (`captureTestBaseline`,
 * `runTieredOracle`) — not the parsers in isolation — against a synthetic
 * `bun test` output whose `X pass / Y fail` summary sits PAST character 4000.
 * The subprocess is mocked so this stays pure/deterministic. This is the test
 * that would have caught the shipped bug: if either entry point ever re-slices
 * before parsing a verdict, the counts collapse to zero and these assertions
 * fail loudly.
 */
describe("oracle end-to-end: verbose failure past the 4000-char slice", () => {
  // Restore the real runner after every test — a plain assignment, so it can
  // never leak the fake into the agent-loop / repair / target-lock suites that
  // also run the oracle (unlike a global Bun.spawnSync spy).
  afterEach(() => __setBunTestRunnerForTests(null));

  // Build a BunTestRun exactly as the real runner would: state from
  // classifyTest, `result.output` truncated to 4000 chars (the feedback slice),
  // `fullOutput` intact. If the oracle ever parses a verdict from the truncated
  // `result.output` instead of `fullOutput`, these assertions collapse to 0.
  function installFakeRun(output: string, exitCode: number) {
    __setBunTestRunnerForTests(() => ({
      state: classifyTest(output, exitCode),
      fullOutput: output,
      result: {
        kind: "test",
        name: "bun-test",
        status: exitCode === 0 ? "passed" : "failed",
        output: output.slice(0, 4000), // feedback slice, exactly like the real runner
        durationMs: 1,
        exitCode,
      },
    }));
  }

  // Leading noise pushes BOTH the `(fail)` lines and the summary past char 4000,
  // exactly like a deep-recursion stack trace. A truncated read sees an empty
  // suite (0 pass / 0 fail); the full read sees 15 red.
  function buildVerboseRedOutput(): string {
    const noise = "at applySearchReplace (applier.ts:329:20)\n".repeat(400); // ~16 KB, leads
    const failLines = Array.from(
      { length: 15 },
      (_, i) => `(fail) verbose failure ${i} [0.1ms]`,
    ).join("\n");
    const out = `${noise}\n${failLines}\n 1 pass\n 15 fail\n Ran 16 tests across 1 file.\n`;
    // Sanity: the summary genuinely lives past the feedback slice.
    if (out.indexOf("15 fail") <= 4000) throw new Error("fixture summary must sit past char 4000");
    return out;
  }

  it("captureTestBaseline reads the real red count, not a truncated 0", () => {
    installFakeRun(buildVerboseRedOutput(), 1);
    const baseline = captureTestBaseline("/fake/repo");
    // The whole bug in one assertion: a truncated parse returns redCount 0,
    // which silently disables the final-state guard. The fix keeps it at 15.
    expect(baseline.redCount).toBe(15);
    expect(baseline.failingIds.size).toBe(15);
    expect(baseline.hadAnyTests).toBe(true);
  });

  it("runTieredOracle reports 'failing' + regressed on a verbose past-slice failure", async () => {
    installFakeRun(buildVerboseRedOutput(), 1);
    // Baseline is fully green (redCount 0) → the 15 reds are all NEW.
    const verdict = await runTieredOracle("/fake/repo", {
      baseline: { failingIds: new Set(), hadAnyTests: true, redCount: 0, loadError: false },
    });
    // A truncated parse would read currentRed 0 and (passCount 0) return a
    // non-regressed "failing" — the loop would then NOT revert. Full parse
    // sees 15 red > 0 baseline → regressed, with all 15 as new failures.
    expect(verdict.outcome).toBe("failing");
    expect(verdict.regressed).toBe(true);
    expect(verdict.newFailures?.length).toBe(15);
  });

  it("runTieredOracle does NOT false-'solved' a green suite whose pass line is past the slice", async () => {
    // The dangerous inverse: a huge passing suite. If the parser truncated, it
    // would see 0 pass / 0 fail → "absent" → fall through to typecheck, losing
    // the proven-green early stop. Full parse must see the pass and solve.
    const noise = "console.log noise line\n".repeat(400);
    const greenOut = `${noise}\n 200 pass\n 0 fail\n Ran 200 tests across 3 files.\n`;
    if (greenOut.indexOf("200 pass") <= 4000) throw new Error("fixture pass line must sit past char 4000");
    installFakeRun(greenOut, 0); // green suite exits 0
    const verdict = await runTieredOracle("/fake/repo", {
      baseline: { failingIds: new Set(), hadAnyTests: true, redCount: 0, loadError: false },
    });
    expect(verdict.outcome).toBe("solved");
  });
});

/**
 * Source-level guard: any `.slice(` / `.substring(` in the oracle MUST be
 * annotated `// feedback-only (not a verdict input)`. This forces a future
 * editor who adds a new truncation near output handling to consciously mark it
 * as feedback-only — or, if they truncate a verdict input, the annotation lies
 * and code review catches it. It makes the truncation-bug class impossible to
 * reintroduce silently.
 */
describe("oracle source guard: every slice is annotated feedback-only", () => {
  const MARKER = "feedback-only (not a verdict input)";

  it("no unannotated .slice(/.substring( in src/verify/oracle.ts", () => {
    const src = readFileSync(new URL("../src/verify/oracle.ts", import.meta.url), "utf8");
    const offenders = src
      .split("\n")
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => /\.slice\(|\.substring\(/.test(text))
      .filter(({ text }) => !text.includes(MARKER));
    // Every match must carry the marker. A new unmarked truncation fails here.
    expect(offenders.map((o) => o.line)).toEqual([]);
  });
});
