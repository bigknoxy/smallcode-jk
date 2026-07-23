import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperatorMutationRepair } from "../src/agent/loop.ts";
import {
  beginRun,
  hasPendingJournal,
  journalPathFor,
  recordOriginals,
  recoverIfNeeded,
} from "../src/agent/journal.ts";
import type { AgentState } from "../src/agent/types.ts";
import type { TestBaseline } from "../src/verify/oracle.ts";

/**
 * Code-review finding (E1 hardening): the deterministic repair passes are a
 * SECOND on-disk write path (they mutate the locked target while probing the
 * oracle). They must be crash-recoverable too, or a kill mid-repair leaves an
 * operator-flip candidate on disk that neither the journal nor the guard catches.
 * The fix routes repair writes through the same journaling wrapper as model-turn
 * edits. This test proves a repair pass records the target's pre-repair bytes so
 * `recoverIfNeeded` can roll them back.
 */

let repo: string;
const REL = "src/t.ts";
const ORIGINAL = "export const f = (a: number, b: number): number => (a < b ? 1 : 2);\n";

const readFileFn = () => async (p: string): Promise<string | null> => {
  try {
    return await readFile(join(repo, p), "utf-8");
  } catch {
    return null;
  }
};
const writeFileFn = () => async (p: string, content: string): Promise<void> => {
  await mkdir(join(repo, p, ".."), { recursive: true }).catch(() => {});
  await writeFile(join(repo, p), content, "utf-8");
};
const rmFn = () => async (p: string): Promise<void> => {
  await rm(join(repo, p), { force: true });
};
// The journaling wrapper the loop passes to repair: record pre-write, then write.
const journalWrite = () => async (p: string, content: string): Promise<void> => {
  await recordOriginals(repo, [p], readFileFn());
  await writeFileFn()(p, content);
};

beforeEach(async () => {
  repo = join(tmpdir(), `repair-journal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, REL), ORIGINAL, "utf-8");
});
afterEach(async () => {
  await rm(journalPathFor(repo), { force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("repair-pass writes are journaled (crash-recoverable)", () => {
  it("operator-mutation repair records the target's pre-repair bytes for recovery", async () => {
    await beginRun(repo, "run-repair", "2026-07-22T00:00:00Z");

    const baseline: TestBaseline = {
      failingIds: new Set(["t"]),
      hadAnyTests: true,
      redCount: 1,
      loadError: false,
    };
    const state = {
      repoRoot: repo,
      lockedTargetPath: REL,
      lockedTargetRange: undefined,
      turns: [],
    } as unknown as AgentState;
    // Fake oracle: every candidate "fails", so repair tries flips and restores —
    // no real `bun test`, deterministic.
    const failOracle = async () => ({ outcome: "failing", checks: [], feedback: "" }) as never;

    const result = await runOperatorMutationRepair(
      state,
      baseline,
      readFileFn(),
      journalWrite(), // the fix: repair writes go through the journal
      failOracle,
    );
    expect(result).toBeNull(); // nothing greened (fake oracle)

    // The repair pass wrote candidates via journalWrite → the journal captured
    // the target's pre-repair content, even though repair restored the file.
    expect(await hasPendingJournal(repo)).toBe(true);

    // Simulate a crash that left a mutated candidate on disk, then recover.
    await writeFile(join(repo, REL), "export const f = () => BROKEN CRASH STATE;\n", "utf-8");
    const rec = await recoverIfNeeded(repo, writeFileFn(), rmFn());
    expect(rec.restored).toContain(REL);
    expect(readFileSync(join(repo, REL), "utf-8")).toBe(ORIGINAL); // pre-repair bytes restored
  });
});
