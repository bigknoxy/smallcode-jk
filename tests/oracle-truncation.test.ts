import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureTestBaseline,
  finalStateWorseThanBaseline,
  parseRedCount,
} from "../src/verify/oracle.ts";

/**
 * Regression guard for the truncation bug that silently disabled the final-state
 * regression guard (and the per-turn revert): `captureTestBaseline` parsed the
 * red count from output that had been sliced to 4000 chars for model-facing
 * feedback. A verbose failure (deep recursion / long stack traces) pushed the
 * `(fail)` markers and the `X pass / Y fail` summary past that cutoff, so the
 * parser read a false "0 red" and the guard concluded the repo was "not worse".
 */
describe("oracle output-truncation regression", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "smallcode-oracle-trunc-"));
    // A suite whose FAILURE output is far larger than 4000 chars: many failing
    // tests, each throwing a long message, so the summary line lands well past
    // the old slice. One passing test so the suite is genuinely mixed.
    const noise = "E".repeat(600);
    const failing = Array.from(
      { length: 15 },
      (_, i) => `it("verbose failure ${i}", () => { throw new Error("${noise}-${i}"); });`,
    ).join("\n");
    writeFileSync(
      join(dir, "big.test.ts"),
      `import { it, expect } from "bun:test";\n` +
        `it("one green", () => { expect(1).toBe(1); });\n` +
        `${failing}\n`,
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts reds from the FULL output even when it exceeds the feedback slice", () => {
    const baseline = captureTestBaseline(dir);
    expect(baseline.hadAnyTests).toBe(true);
    // The fix: 15 failing tests are counted. Pre-fix this read 0 because the
    // summary was beyond the 4000-char slice.
    expect(baseline.redCount).toBe(15);
    expect(baseline.failingIds.size).toBeGreaterThan(0);
  });

  it("demonstrates the truncation would have hidden the reds (documents the bug)", () => {
    // Reconstruct the exact failure mode against a synthetic long output: the
    // summary sits past char 4000, so a truncated parse reads 0 while the full
    // parse reads the real count.
    const longOut = "x".repeat(5000) + "\n 1 pass\n 15 fail\n Ran 16 tests\n";
    expect(parseRedCount(longOut)).toBe(15);
    expect(parseRedCount(longOut.slice(0, 4000))).toBe(0);
  });

  it("finalStateWorseThanBaseline flags a real count regression", () => {
    const base = { failingIds: new Set(["a", "b"]), hadAnyTests: true, redCount: 2, loadError: false };
    const worse = { failingIds: new Set(["a", "b", "c", "d"]), hadAnyTests: true, redCount: 4, loadError: false };
    expect(finalStateWorseThanBaseline(base, worse).worse).toBe(true);
    expect(finalStateWorseThanBaseline(base, base).worse).toBe(false);
  });
});
