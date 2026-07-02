import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workingChanges,
  makeInteractiveApprover,
  changedSets,
  recordAgentChanges,
  readManifest,
  revertAgentChanges,
} from "../src/cli/commands/review.ts";
import { mkdirSync, readFileSync, existsSync } from "node:fs";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string) {
  Bun.spawnSync(["git", ...args], { cwd });
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "review-"));
  dirs.push(dir);
  await writeFile(join(dir, "a.txt"), "one\n");
  git(["init", "-q"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "x"], dir); // ensure repo
  git(["add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
  return dir;
}

describe("workingChanges (R9 diff/undo core)", () => {
  test("clean tree → no changes", async () => {
    const dir = await repo();
    const c = workingChanges(dir);
    expect(c.hasChanges).toBe(false);
    expect(c.untracked).toEqual([]);
  });

  test("detects a modified tracked file", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "two\n");
    const c = workingChanges(dir);
    expect(c.hasChanges).toBe(true);
    expect(c.stat).toContain("a.txt");
  });

  test("detects an untracked (agent-created) file", async () => {
    const dir = await repo();
    await writeFile(join(dir, "new.txt"), "x\n");
    const c = workingChanges(dir);
    expect(c.hasChanges).toBe(true);
    expect(c.untracked).toContain("new.txt");
  });

  test("makeInteractiveApprover only arms when approval is required", () => {
    expect(makeInteractiveApprover(false)).toBeUndefined();
    expect(makeInteractiveApprover(undefined)).toBeUndefined();
    expect(typeof makeInteractiveApprover(true)).toBe("function"); // diff-review hook armed
  });

  test("makeInteractiveApprover bypasses the prompt headlessly (issue #91)", () => {
    // Interactive TTY → the y/N hook is armed.
    expect(typeof makeInteractiveApprover(true, { interactive: true })).toBe("function");
    // No TTY → hook is NOT armed (would auto-decline every edit); apply instead.
    const origWrite = process.stderr.write.bind(process.stderr);
    let warned = "";
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      warned += s;
      return true;
    };
    try {
      expect(makeInteractiveApprover(true, { interactive: false })).toBeUndefined();
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
    expect(warned).toContain("not a TTY");
    // Explicit --yes bypass → no hook regardless of TTY.
    expect(makeInteractiveApprover(true, { bypass: true, interactive: true })).toBeUndefined();
    // Approval not required → still undefined even headless (no spurious warning).
    expect(makeInteractiveApprover(false, { interactive: false })).toBeUndefined();
  });

  test("after git restore + clean, tree is reported clean again", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await writeFile(join(dir, "new.txt"), "x\n");
    expect(workingChanges(dir).hasChanges).toBe(true);
    git(["restore", "--", "."], dir);
    git(["clean", "-fd"], dir);
    expect(workingChanges(dir).hasChanges).toBe(false);
  });
});

describe("scoped undo manifest (SAFETY: never touch the user's own work)", () => {
  test("records only the agent's changes (excludes pre-existing user edits)", async () => {
    const dir = await repo();
    mkdirSync(join(dir, ".smallcode"), { recursive: true });
    // user dirties their own work FIRST
    await writeFile(join(dir, "a.txt"), "user-edit\n"); // tracked, user-modified
    await writeFile(join(dir, "user-new.txt"), "mine\n"); // untracked, user-created
    const before = changedSets(dir);
    // agent then changes other things
    await writeFile(join(dir, "b.txt"), "agent\n"); // NEW tracked? b.txt isn't tracked → untracked
    git(["add", "b.txt"], dir);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add b"], dir);
    await writeFile(join(dir, "b.txt"), "agent-edit\n"); // now tracked-modified by agent
    await writeFile(join(dir, "agent-new.txt"), "x\n"); // agent-created
    await recordAgentChanges(dir, before);

    const m = readManifest(dir)!;
    expect(m.tracked).toEqual(["b.txt"]);
    expect(m.untracked).toEqual(["agent-new.txt"]);
    // user paths NOT in the manifest
    expect(m.tracked).not.toContain("a.txt");
    expect(m.untracked).not.toContain("user-new.txt");
  });

  test("revert restores agent edits + deletes agent files, leaves user work intact", async () => {
    const dir = await repo();
    mkdirSync(join(dir, ".smallcode"), { recursive: true });
    await writeFile(join(dir, "a.txt"), "USER\n"); // user edit (must survive)
    await writeFile(join(dir, "user-new.txt"), "MINE\n"); // user file (must survive)
    const before = changedSets(dir);
    await writeFile(join(dir, "agent-new.txt"), "AGENT\n"); // agent file (must die)
    await recordAgentChanges(dir, before);

    const reverted = revertAgentChanges(dir);
    expect(reverted?.untracked).toEqual(["agent-new.txt"]);
    // agent file gone, user work untouched
    expect(existsSync(join(dir, "agent-new.txt"))).toBe(false);
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("USER\n");
    expect(readFileSync(join(dir, "user-new.txt"), "utf-8")).toBe("MINE\n");
    // manifest cleared after revert
    expect(readManifest(dir)).toBeNull();
  });

  test("no manifest → revert is a no-op (null), never blanket-cleans", () => {
    return repo().then((dir) => {
      expect(readManifest(dir)).toBeNull();
      expect(revertAgentChanges(dir)).toBeNull();
    });
  });
});
