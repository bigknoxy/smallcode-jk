import { describe, expect, it } from "bun:test";
import { finalStateWorseThanBaseline, parseFailingTestIds, parseRedCount } from "../src/verify/oracle.ts";

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
