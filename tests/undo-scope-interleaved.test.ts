import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSets, recordAgentChanges, revertAgentChanges } from "../src/cli/commands/review.ts";

/**
 * E1-T6 — `undo` must revert ONLY the agent's own changes, never the user's
 * concurrent/pre-existing edits. #68 scoped undo to a manifest computed as
 * (dirty AFTER the run) MINUS (dirty BEFORE the run), so any file the user had
 * already touched is excluded and never `git restore`d. This test simulates the
 * interleaving that would break a naive `git restore .` / `git clean`:
 *
 *   A — user pre-edited it, THEN the agent also edited it   → ambiguous overlap
 *   B — user-only edit                                      → never the agent's
 *   D — agent-only edit (clean before the run)              → genuinely the agent's
 *   C — agent-created file                                  → genuinely the agent's
 *
 * Expected: undo reverts D and deletes C (the agent's own work), and leaves A
 * and B completely untouched — the user's edits survive, and the file the agent
 * can't cleanly separate (A) fails safe (left alone), never clobbered.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
}

async function committedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "undo-scope-"));
  dirs.push(dir);
  await writeFile(join(dir, "A.txt"), "A committed\n");
  await writeFile(join(dir, "B.txt"), "B committed\n");
  await writeFile(join(dir, "D.txt"), "D committed\n");
  git(["init", "-q"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "init"], dir);
  return dir;
}

describe("undo scope — interleaved human + agent edits", () => {
  test("reverts only agent files; user edits (incl. an overlapping file) survive", async () => {
    const dir = await committedRepo();

    // The USER makes uncommitted edits BEFORE the agent run: file B, and also a
    // different edit to file A.
    await writeFile(join(dir, "A.txt"), "A committed\nUSER EDIT on A\n");
    await writeFile(join(dir, "B.txt"), "B committed\nUSER EDIT on B\n");

    // Snapshot the pre-run dirty set exactly as `smallcode run` does.
    const before = changedSets(dir);
    expect(before.tracked.has("A.txt")).toBe(true); // A already dirty (user)
    expect(before.tracked.has("B.txt")).toBe(true); // B already dirty (user)

    // The AGENT runs: further edits A, edits the (clean) D, and creates C.
    await writeFile(join(dir, "A.txt"), "A committed\nUSER EDIT on A\nAGENT EDIT on A\n");
    await writeFile(join(dir, "D.txt"), "D committed\nAGENT EDIT on D\n");
    await writeFile(join(dir, "C.txt"), "AGENT CREATED C\n");

    await recordAgentChanges(dir, before);

    // A was already dirty before the run → excluded from the manifest (ambiguous
    // overlap fails safe). B is user-only → never claimed. D/C are the agent's.
    const reverted = revertAgentChanges(dir);
    expect(reverted).not.toBeNull();
    expect(reverted?.tracked).toEqual(["D.txt"]); // only the agent-only file
    expect(reverted?.untracked).toEqual(["C.txt"]); // only the agent-created file

    // User work survives untouched.
    expect(readFileSync(join(dir, "B.txt"), "utf-8")).toBe("B committed\nUSER EDIT on B\n");
    // A is left alone (both user + agent edits remain) — never clobbered.
    expect(readFileSync(join(dir, "A.txt"), "utf-8")).toBe(
      "A committed\nUSER EDIT on A\nAGENT EDIT on A\n",
    );
    // Agent's own work is undone: D restored to committed, C deleted.
    expect(readFileSync(join(dir, "D.txt"), "utf-8")).toBe("D committed\n");
    expect(existsSync(join(dir, "C.txt"))).toBe(false);
  });

  test("a purely-user session records nothing and undo is a no-op", async () => {
    const dir = await committedRepo();
    await writeFile(join(dir, "B.txt"), "B committed\nUSER EDIT\n");
    const before = changedSets(dir);
    // Agent does nothing new.
    await recordAgentChanges(dir, before);
    // Nothing the agent changed → no manifest entries → undo is a no-op.
    expect(revertAgentChanges(dir)).toBeNull();
    expect(readFileSync(join(dir, "B.txt"), "utf-8")).toBe("B committed\nUSER EDIT\n");
  });
});
