import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingChanges, makeInteractiveApprover } from "../src/cli/commands/review.ts";

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
