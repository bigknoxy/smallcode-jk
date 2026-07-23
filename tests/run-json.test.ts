/**
 * Unit tests for `formatRunJson` — the pure `--json` payload builder for
 * `smallcode run`. Also covers `numstatChanges` (review.ts), the git-diff parser
 * that feeds it filesChanged/added/removed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "../src/agent/types.ts";
import { numstatChanges } from "../src/cli/commands/review.ts";
import { formatRunJson } from "../src/cli/commands/run.ts";

const STATE_PATH = "/tmp/test/.smallcode/state.json";

function makeState(
  overrides: Partial<Pick<AgentState, "status" | "verified" | "turns" | "finalStateReverted">>,
): Pick<AgentState, "status" | "verified" | "turns" | "finalStateReverted"> {
  return {
    status: "done",
    verified: true,
    turns: [],
    ...overrides,
  };
}

function turn() {
  return {
    turn: 1,
    goalId: "goal-1",
    prompt: "",
    rawResponse: "",
    answer: "",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 10,
    completionTokens: 5,
    timestamp: Date.now(),
  } as AgentState["turns"][number];
}

describe("formatRunJson", () => {
  it("verified/done state → ok=true, verified=true, reason empty", () => {
    const state = makeState({ status: "done", verified: true, turns: [turn(), turn()] });
    const classification = {
      ok: true,
      tone: "success" as const,
      message: "Done — tests verified passing",
    };
    const changes = { filesChanged: ["a.ts", "b.ts"], added: 5, removed: 2 };
    const result = formatRunJson(state, classification, changes, "qwen2.5-coder:3b");

    expect(result).toEqual({
      ok: true,
      verified: true,
      status: "done",
      model: "qwen2.5-coder:3b",
      turnsUsed: 2,
      filesChanged: ["a.ts", "b.ts"],
      added: 5,
      removed: 2,
      reason: "",
      // E1-T5 outcome fields: solved by the model, no guard, no rescue.
      mechanism: "model",
      mechanismDetail: "",
      guardFired: false,
      restoreVerified: null,
      filesRestored: 0,
      failingTests: [],
    });
  });

  it("unverified/max_turns state → ok=false, reason = classification.message", () => {
    const state = makeState({ status: "max_turns", verified: undefined, turns: [turn()] });
    const classification = {
      ok: false,
      tone: "error" as const,
      message: `Hit max turns without solving — check ${STATE_PATH}`,
    };
    const changes = { filesChanged: [], added: 0, removed: 0 };
    const result = formatRunJson(state, classification, changes, "vibethinker-3b");

    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.status).toBe("max_turns");
    expect(result.turnsUsed).toBe(1);
    expect(result.reason).toBe(classification.message);
  });

  it("done but unverified → verified=false even though status is done", () => {
    const state = makeState({ status: "done", verified: false, turns: [] });
    const classification = {
      ok: false,
      tone: "warn" as const,
      message: "Finished, but tests are NOT verified passing",
    };
    const result = formatRunJson(
      state,
      classification,
      { filesChanged: [], added: 0, removed: 0 },
      "m",
    );
    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("NOT verified");
  });

  it("no-git repo → empty filesChanged, 0 added/removed", () => {
    const state = makeState({ status: "done", verified: true, turns: [turn()] });
    const classification = {
      ok: true,
      tone: "success" as const,
      message: "Done — tests verified passing",
    };
    const changes = { filesChanged: [], added: 0, removed: 0 };
    const result = formatRunJson(state, classification, changes, "m");
    expect(result.filesChanged).toEqual([]);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// numstatChanges — real git fixture repo
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string) {
  Bun.spawnSync(["git", ...args], { cwd });
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "numstat-"));
  dirs.push(dir);
  await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(["init", "-q"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
  return dir;
}

describe("numstatChanges", () => {
  it("counts added/removed lines for a tracked-file edit", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "one\ntwo\nTHREE-changed\nfour\n");
    const result = numstatChanges(dir);
    expect(result.filesChanged).toContain("a.txt");
    expect(result.added).toBeGreaterThan(0);
    expect(result.removed).toBeGreaterThan(0);
  });

  it("includes untracked (new) files with zero counted diff lines", async () => {
    const dir = await repo();
    await writeFile(join(dir, "new-file.txt"), "brand new\n");
    const result = numstatChanges(dir);
    expect(result.filesChanged).toContain("new-file.txt");
  });

  it("clean tree → empty filesChanged", async () => {
    const dir = await repo();
    const result = numstatChanges(dir);
    expect(result.filesChanged).toEqual([]);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });
});
