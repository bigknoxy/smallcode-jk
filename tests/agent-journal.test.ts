import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginRun,
  hasPendingJournal,
  journalPathFor,
  markClean,
  recordOriginals,
  recoverIfNeeded,
  recoverRepo,
} from "../src/agent/journal.ts";

/**
 * Write-ahead apply journal — crash recovery. These tests drive the module with
 * a real temp repo (mirroring the final-state-guard tests) and simulate a crash
 * by NOT calling markClean before recovering — exactly what a kill/OOM does: the
 * in-process guard never runs, the journal survives, the NEXT run replays it.
 */

let repo: string;

function relWrite(): (p: string, content: string) => Promise<void> {
  return async (p, content) => {
    await mkdir(join(repo, p, ".."), { recursive: true }).catch(() => {});
    await writeFile(join(repo, p), content, "utf-8");
  };
}
function relRm(): (p: string) => Promise<void> {
  return async (p) => {
    await rm(join(repo, p), { force: true });
  };
}
function capture(): (p: string) => Promise<string | null> {
  return async (p) => {
    try {
      return await readFile(join(repo, p), "utf-8");
    } catch {
      return null;
    }
  };
}
async function exists(p: string): Promise<boolean> {
  try {
    await access(join(repo, p));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  repo = join(tmpdir(), `smallcode-journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(repo, { recursive: true });
});

afterEach(async () => {
  await rm(journalPathFor(repo), { force: true }); // never leak a journal between tests
  await rm(repo, { recursive: true, force: true });
});

describe("apply journal — crash recovery", () => {
  it("restores an edited file and deletes a created file when the run crashed mid-apply", async () => {
    // Pre-run state: a.ts exists; b.ts does not.
    await writeFile(join(repo, "a.ts"), "ORIGINAL A\n", "utf-8");

    await beginRun(repo, "run-1", "2026-07-22T00:00:00Z");
    // The run is about to edit a.ts and create b.ts → record BEFORE writing.
    await recordOriginals(repo, ["a.ts", "b.ts"], capture());

    // Apply: overwrite a.ts, create b.ts — then "crash" (no markClean).
    await writeFile(join(repo, "a.ts"), "MANGLED A\n", "utf-8");
    await writeFile(join(repo, "b.ts"), "half written b\n", "utf-8");

    // Next invocation recovers.
    const res = await recoverIfNeeded(repo, relWrite(), relRm());

    expect(res.recovered).toBe(true);
    expect(res.restored).toEqual(["a.ts"]);
    expect(res.deleted).toEqual(["b.ts"]);
    expect(await readFile(join(repo, "a.ts"), "utf-8")).toBe("ORIGINAL A\n"); // restored to pristine
    expect(await exists("b.ts")).toBe(false); // created file deleted
    // Journal consumed → a second recovery is a no-op.
    expect(await hasPendingJournal(repo)).toBe(false);
    expect((await recoverIfNeeded(repo, relWrite(), relRm())).recovered).toBe(false);
  });

  it("markClean leaves nothing to recover (a clean run keeps its changes)", async () => {
    await writeFile(join(repo, "a.ts"), "ORIGINAL A\n", "utf-8");
    await beginRun(repo, "run-2", "2026-07-22T00:00:00Z");
    await recordOriginals(repo, ["a.ts"], capture());
    await writeFile(join(repo, "a.ts"), "GOOD FIX A\n", "utf-8");
    await markClean(repo);

    const res = await recoverIfNeeded(repo, relWrite(), relRm());
    expect(res.recovered).toBe(false);
    expect(await readFile(join(repo, "a.ts"), "utf-8")).toBe("GOOD FIX A\n"); // change preserved
  });

  it("first-seen wins: a file edited across turns is restored to its PRE-RUN content", async () => {
    await writeFile(join(repo, "a.ts"), "PRE-RUN\n", "utf-8");
    await beginRun(repo, "run-3", "2026-07-22T00:00:00Z");

    // Turn 1 records + writes.
    await recordOriginals(repo, ["a.ts"], capture());
    await writeFile(join(repo, "a.ts"), "TURN1\n", "utf-8");
    // Turn 2 records again (must NOT overwrite the pre-run capture) + writes.
    await recordOriginals(repo, ["a.ts"], capture());
    await writeFile(join(repo, "a.ts"), "TURN2 (crash)\n", "utf-8");

    const res = await recoverIfNeeded(repo, relWrite(), relRm());
    expect(res.restored).toEqual(["a.ts"]);
    expect(await readFile(join(repo, "a.ts"), "utf-8")).toBe("PRE-RUN\n"); // NOT "TURN1"
  });

  it("no journal at all → recovery is a no-op", async () => {
    const res = await recoverIfNeeded(repo, relWrite(), relRm());
    expect(res.recovered).toBe(false);
    expect(res.restored).toEqual([]);
    expect(res.deleted).toEqual([]);
    expect(res.failed).toEqual([]);
  });

  it("best-effort: a restore that throws is collected in `failed`, not propagated", async () => {
    await writeFile(join(repo, "a.ts"), "ORIGINAL A\n", "utf-8");
    await beginRun(repo, "run-x", "2026-07-22T00:00:00Z");
    await recordOriginals(repo, ["a.ts", "b.ts"], capture());
    await writeFile(join(repo, "a.ts"), "MANGLED\n", "utf-8");
    await writeFile(join(repo, "b.ts"), "created\n", "utf-8");

    // Writer throws for a.ts (simulate a disk error); deletion of b.ts still works.
    const failingWrite = async (p: string, c: string): Promise<void> => {
      if (p === "a.ts") throw new Error("simulated write failure");
      await relWrite()(p, c);
    };
    const res = await recoverIfNeeded(repo, failingWrite, relRm());

    expect(res.failed).toEqual(["a.ts"]); // recorded, not thrown
    expect(res.deleted).toEqual(["b.ts"]); // the other entry still recovered
    expect(await exists("b.ts")).toBe(false);
    // Journal is still consumed so the failure isn't retried forever.
    expect(await hasPendingJournal(repo)).toBe(false);
  });

  it("recordOriginals is a no-op when no run has begun (feature disabled / no journal)", async () => {
    // No beginRun → nothing recorded, nothing to recover.
    await recordOriginals(repo, ["a.ts"], capture());
    expect(await hasPendingJournal(repo)).toBe(false);
  });

  it("recoverRepo (self-contained, for the chat REPL) rolls a crashed task back to pre-task state", async () => {
    // Models the chat-REPL hazard: task N wrote files then threw before markClean.
    await writeFile(join(repo, "a.ts"), "PRE-TASK A\n", "utf-8");
    await beginRun(repo, "task-N", "2026-07-22T00:00:00Z");
    await recordOriginals(repo, ["a.ts", "b.ts"], capture());
    await writeFile(join(repo, "a.ts"), "PARTIAL EDIT\n", "utf-8");
    await writeFile(join(repo, "b.ts"), "partial new file\n", "utf-8");

    // chat's catch calls recoverRepo (no injected fns — builds its own path-safe I/O).
    const rec = await recoverRepo(repo);

    expect(rec.recovered).toBe(true);
    expect(await readFile(join(repo, "a.ts"), "utf-8")).toBe("PRE-TASK A\n");
    expect(await exists("b.ts")).toBe(false);
    // Journal consumed → the NEXT REPL task starts clean (no surprise rollback).
    expect(await hasPendingJournal(repo)).toBe(false);
  });

  it("journalPathFor is stable per repo and distinct across repos", () => {
    expect(journalPathFor(repo)).toBe(journalPathFor(repo));
    expect(journalPathFor(repo)).not.toBe(journalPathFor(`${repo}-other`));
    expect(journalPathFor(repo).startsWith(join(tmpdir(), "smallcode-journal"))).toBe(true);
  });
});
