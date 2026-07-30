import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetOracleCacheForTests,
  __setBunTestRunnerForTests,
  type BunTestRun,
  runTieredOracle,
} from "../src/verify/oracle.ts";
import { getOracleCostStats, resetOracleCostStats } from "../src/verify/oracle-cost.ts";

/**
 * E6-T3: the oracle's no-change skip. The cache is allowed to save time; it is
 * NOT allowed to change an answer. Every test here is about the second half —
 * a stale verdict decides whether an edit is kept, which is the one failure
 * mode E6 exists to make impossible.
 *
 * Real git repos on disk (the fingerprint reads git), fake `bun test` runs
 * (the seam), no model. Spawn counting rides on the E6-T1 cost counter, which
 * increments once per real runner call and never on a cache hit.
 */

let repo: string;
let runs = 0;
let output = "";

/** A `bun test` run the fake runner returns. `output` drives the verdict. */
function fakeRun(text: string, complete = true): BunTestRun {
  return {
    state: /\d+ fail/.test(text) && !/^0 fail/m.test(text) ? "red" : "green",
    fullOutput: text,
    complete,
    result: {
      kind: "test",
      name: "bun-test",
      status: "passed",
      output: text,
      durationMs: 1,
      exitCode: 0,
    },
  };
}

const GREEN = "12 pass\n0 fail\n";
const RED = "10 pass\n2 fail\n(fail) mod > does a thing\n";

function git(...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo });
  if ((p.exitCode ?? 1) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "smallcode-oracle-cache-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "init");

  runs = 0;
  output = GREEN;
  __resetOracleCacheForTests();
  resetOracleCostStats();
  __setBunTestRunnerForTests(() => {
    runs++;
    return fakeRun(output);
  });
  process.env["SMALLCODE_ORACLE_CACHE"] = "1";
});

afterEach(() => {
  __setBunTestRunnerForTests(null);
  __resetOracleCacheForTests();
  delete process.env["SMALLCODE_ORACLE_CACHE"];
  rmSync(repo, { recursive: true, force: true });
});

/** Typecheck disabled: Tier 2 is not what these tests measure. */
const oracle = (opts = {}) => runTieredOracle(repo, { typecheck: null, ...opts });

describe("oracle cache — the flag is a real switch", () => {
  test("OFF ⇒ every call spawns (behavior identical to before the cache existed)", async () => {
    process.env["SMALLCODE_ORACLE_CACHE"] = "0";
    await oracle();
    await oracle();
    await oracle();
    expect(runs).toBe(3);
    expect(getOracleCostStats().calls).toBe(3);
  });

  test("unset ⇒ default OFF", async () => {
    delete process.env["SMALLCODE_ORACLE_CACHE"];
    await oracle();
    await oracle();
    expect(runs).toBe(2);
  });

  test("=0 is honored even after the cache is already warm (hard kill switch)", async () => {
    await oracle();
    await oracle();
    expect(runs).toBe(1); // warm
    process.env["SMALLCODE_ORACLE_CACHE"] = "0";
    await oracle();
    expect(runs).toBe(2); // killed — spawned despite a matching entry sitting there
  });
});

describe("oracle cache — hits only on a provably identical state", () => {
  test("ON, nothing changed ⇒ second call does not spawn and returns the same verdict", async () => {
    const first = await oracle();
    const second = await oracle();
    expect(runs).toBe(1);
    expect(second).toEqual(first);
  });

  test("a cache hit is not billed as an oracle call (the saving must be visible)", async () => {
    await oracle();
    await oracle();
    expect(getOracleCostStats().calls).toBe(1);
  });

  test("editing a tracked file MISSES and re-spawns", async () => {
    await oracle();
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    await oracle();
    expect(runs).toBe(2);
  });

  test("a stale entry can never win: the same state re-run after an edit-and-revert is still correct", async () => {
    // Green at state S. Edit away, go red. Revert to S byte-for-byte: the
    // memo for S is hit, and it must still say green — the verdict tracks the
    // STATE, not the most recent run.
    const green = await oracle();
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    output = RED;
    const red = await oracle();
    expect(red.outcome).toBe("failing");
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    const back = await oracle();
    expect(runs).toBe(2); // the revert hit S's memo
    expect(back).toEqual(green);
    expect(back.outcome).toBe("solved");
  });

  test("an untracked non-ignored file ⇒ null fingerprint ⇒ always spawns, never stores", async () => {
    writeFileSync(join(repo, "scratch.ts"), "x");
    await oracle();
    await oracle();
    expect(runs).toBe(2);
  });

  test("a non-git directory ⇒ null fingerprint ⇒ always spawns", async () => {
    const plain = mkdtempSync(join(tmpdir(), "smallcode-oracle-nogit-"));
    try {
      await runTieredOracle(plain, { typecheck: null });
      await runTieredOracle(plain, { typecheck: null });
      expect(runs).toBe(2);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("oracle cache — never memoize an incomplete run", () => {
  test("a timed-out run is not stored (its output is a prefix of the truth)", async () => {
    __setBunTestRunnerForTests(() => {
      runs++;
      // Killed mid-suite: the visible red count is whatever had printed so far.
      return fakeRun("3 pass\n0 fail\n", false);
    });
    await oracle();
    await oracle();
    expect(runs).toBe(2);
  });
});

describe("oracle cache — the verdict is re-derived, never memoized whole", () => {
  test("the same cached run yields a baseline-correct verdict for a DIFFERENT baseline", async () => {
    output = RED;
    // Baseline A knew about the failure ⇒ not a new regression.
    const knew = await oracle({
      baseline: { failingIds: new Set(["mod > does a thing"]), redCount: 2 },
    });
    // Baseline B did not ⇒ the SAME disk state is a regression. If the verdict
    // itself were memoized, this second call would wrongly report `knew`.
    const surprised = await oracle({
      baseline: { failingIds: new Set<string>(), redCount: 0 },
    });
    expect(runs).toBe(1); // the expensive suite ran once...
    expect(knew.newFailures).toEqual([]); // ...but the answers differ
    expect(surprised.newFailures).toEqual(["mod > does a thing"]);
    expect(surprised.regressed).toBe(true);
  });
});

describe("oracle cache — DX", () => {
  test("a hit prints one line naming the reason", async () => {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await oracle();
      await oracle();
    } finally {
      console.log = real;
    }
    expect(lines).toContain("oracle: cached (unchanged repo state)");
  });
});
