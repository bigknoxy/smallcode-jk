import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState, TurnRecord } from "@/agent/types.ts";
import { TranscriptStore } from "@/eval/transcript-store.ts";
import { listCandidates, promoteToSuite } from "@/improve/promoter.ts";
import { SessionLogger } from "@/improve/session-logger.ts";
import { extractTaskFromSession } from "@/improve/task-extractor.ts";
import type { SessionLogEntry } from "@/improve/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = join(
    tmpdir(),
    `improve-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function makeAgentState(overrides?: Partial<AgentState>): AgentState {
  return {
    sessionId: "abcdef1234567890",
    task: "Fix the broken import",
    repoRoot: "/tmp/repo",
    modelId: "claude-3-haiku",
    goals: [],
    currentGoalIndex: 0,
    turns: [],
    status: "failed",
    scratchpad: "",
    startedAt: 1000,
    updatedAt: 5000,
    maxTurns: 10,
    ...overrides,
  };
}

function makeTurn(overrides?: Partial<TurnRecord>): TurnRecord {
  return {
    turn: 0,
    goalId: "goal-1",
    prompt: "Fix it",
    rawResponse: "ok",
    answer: "ok",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 100,
    completionTokens: 50,
    timestamp: 2000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionLogger", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let store: TranscriptStore;
  let logPath: string;

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
    store = new TranscriptStore(join(dir, "transcripts"));
    logPath = join(dir, "sessions.jsonl");
  });

  afterEach(async () => {
    await cleanup();
  });

  it("logSession creates log file and writes entry", async () => {
    const logger = new SessionLogger(logPath, store);
    const state = makeAgentState({
      turns: [makeTurn({ promptTokens: 200, completionTokens: 80 })],
    });

    await logger.logSession(state, "/tmp/transcript.json");

    const raw = await readFile(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0] ?? "{}") as SessionLogEntry;
    expect(parsed.sessionId).toBe("abcdef1234567890");
    expect(parsed.nTurns).toBe(1);
    expect(parsed.nTokens).toBe(280);
    expect(parsed.latencyMs).toBe(4000);
    expect(parsed.outcome).toBe("failed");
    expect(parsed.transcriptPath).toBe("/tmp/transcript.json");
  });

  it("readLog returns entries newest-first", async () => {
    const logger = new SessionLogger(logPath, store);

    const stateA = makeAgentState({
      sessionId: "aaaa0000",
      status: "done",
      startedAt: 1000,
      updatedAt: 2000,
    });
    const stateB = makeAgentState({
      sessionId: "bbbb1111",
      status: "failed",
      startedAt: 3000,
      updatedAt: 4000,
    });
    const stateC = makeAgentState({
      sessionId: "cccc2222",
      status: "max_turns",
      startedAt: 5000,
      updatedAt: 6000,
    });

    await logger.logSession(stateA, "/tmp/a.json");
    await logger.logSession(stateB, "/tmp/b.json");
    await logger.logSession(stateC, "/tmp/c.json");

    const entries = await logger.readLog();
    expect(entries.length).toBe(3);
    // Newest written last → reversed → first in output
    expect(entries[0]?.sessionId).toBe("cccc2222");
    expect(entries[1]?.sessionId).toBe("bbbb1111");
    expect(entries[2]?.sessionId).toBe("aaaa0000");
  });

  it("getFailedSessions filters by outcome", async () => {
    const logger = new SessionLogger(logPath, store);

    await logger.logSession(
      makeAgentState({ sessionId: "done-0000", status: "done" }),
      "/tmp/1.json",
    );
    await logger.logSession(
      makeAgentState({ sessionId: "fail-1111", status: "failed" }),
      "/tmp/2.json",
    );
    await logger.logSession(
      makeAgentState({ sessionId: "maxt-2222", status: "max_turns" }),
      "/tmp/3.json",
    );
    await logger.logSession(
      makeAgentState({ sessionId: "abnd-3333", status: "abandoned" }),
      "/tmp/4.json",
    );

    const failed = await logger.getFailedSessions();
    expect(failed.length).toBe(2);
    expect(failed.every((e) => e.outcome === "failed" || e.outcome === "max_turns")).toBe(true);
  });

  it("getPassedSessions filters by outcome === 'done'", async () => {
    const logger = new SessionLogger(logPath, store);

    await logger.logSession(
      makeAgentState({ sessionId: "done-0000", status: "done" }),
      "/tmp/1.json",
    );
    await logger.logSession(
      makeAgentState({ sessionId: "fail-1111", status: "failed" }),
      "/tmp/2.json",
    );
    await logger.logSession(
      makeAgentState({ sessionId: "done-2222", status: "done" }),
      "/tmp/3.json",
    );
    await logger.logSession(
      makeAgentState({ sessionId: "maxt-3333", status: "max_turns" }),
      "/tmp/4.json",
    );

    const passed = await logger.getPassedSessions();
    expect(passed.length).toBe(2);
    expect(passed.every((e) => e.outcome === "done")).toBe(true);
    // Confirm no failed/max_turns sessions leaked in.
    expect(passed.some((e) => e.outcome === "failed" || e.outcome === "max_turns")).toBe(false);
  });

  it("getPassedSessions respects limit", async () => {
    const logger = new SessionLogger(logPath, store);

    for (let i = 0; i < 5; i++) {
      await logger.logSession(
        makeAgentState({ sessionId: `done-${String(i).padStart(4, "0")}`, status: "done" }),
        `/tmp/${i}.json`,
      );
    }

    const passed = await logger.getPassedSessions(3);
    expect(passed.length).toBe(3);
  });

  it("getPassedSessions returns empty array when no passing sessions exist", async () => {
    const logger = new SessionLogger(logPath, store);

    await logger.logSession(
      makeAgentState({ sessionId: "fail-0000", status: "failed" }),
      "/tmp/1.json",
    );

    const passed = await logger.getPassedSessions();
    expect(passed.length).toBe(0);
  });

  it("readLog skips corrupt lines gracefully", async () => {
    const logger = new SessionLogger(logPath, store);

    await logger.logSession(makeAgentState({ sessionId: "good-aaaa" }), "/tmp/good.json");

    // Inject a corrupt line
    await writeFile(logPath, `${await readFile(logPath, "utf-8")}NOT_JSON\n`);

    await logger.logSession(makeAgentState({ sessionId: "good-bbbb" }), "/tmp/good2.json");

    const entries = await logger.readLog();
    // Should have 2 good entries (corrupt line skipped)
    expect(entries.length).toBe(2);
    expect(entries.some((e) => e.sessionId === "good-aaaa")).toBe(true);
    expect(entries.some((e) => e.sessionId === "good-bbbb")).toBe(true);
  });
});

describe("extractTaskFromSession", () => {
  function makeEntry(overrides?: Partial<SessionLogEntry>): SessionLogEntry {
    return {
      sessionId: "abcdef1234567890",
      taskDesc: "Fix the broken import",
      repoRoot: "/tmp/repo",
      modelId: "claude-3-haiku",
      outcome: "failed",
      nTurns: 3,
      nTokens: 900,
      latencyMs: 4000,
      transcriptPath: "/tmp/t.json",
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it("produces task with correct id prefix", () => {
    const entry = makeEntry();
    const state = makeAgentState();
    const candidate = extractTaskFromSession(entry, state, { taskIdPrefix: "custom" });

    expect(candidate.task.id).toBe("custom-abcdef12");
    expect(candidate.id).toBe("custom-abcdef12");
  });

  it("includes 'promoted' tag by default", () => {
    const entry = makeEntry();
    const state = makeAgentState();
    const candidate = extractTaskFromSession(entry, state);

    expect(candidate.task.tags).toContain("promoted");
    expect(candidate.task.tags).toContain("needs-review");
  });

  it("default grader is static_analysis when no tool results", () => {
    const entry = makeEntry();
    const state = makeAgentState({ turns: [] });
    const candidate = extractTaskFromSession(entry, state);

    expect(candidate.task.graders.length).toBe(1);
    expect(candidate.task.graders[0]?.type).toBe("static_analysis");
  });

  it("detects failed run_tests → deterministic_tests grader", () => {
    const entry = makeEntry();
    const turn = makeTurn({
      toolResults: [{ name: "run_tests", success: false, output: "2 tests failed" }],
    });
    const state = makeAgentState({ turns: [turn] });
    const candidate = extractTaskFromSession(entry, state);

    const types = candidate.task.graders.map((g) => g.type);
    expect(types).toContain("deterministic_tests");
  });

  it("sourceSessionId and sourceTranscriptPath are set correctly", () => {
    const entry = makeEntry({ sessionId: "xyz123abc456def0", transcriptPath: "/tmp/xyz.json" });
    const state = makeAgentState({ sessionId: "xyz123abc456def0" });
    const candidate = extractTaskFromSession(entry, state);

    expect(candidate.sourceSessionId).toBe("xyz123abc456def0");
    expect(candidate.sourceTranscriptPath).toBe("/tmp/xyz.json");
  });
});

describe("promoteToSuite and listCandidates", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
  });

  afterEach(async () => {
    await cleanup();
  });

  function makeCandidate(id: string, promotedAt: number) {
    return {
      id,
      sourceSessionId: `sess-${id}`,
      sourceTranscriptPath: "/tmp/t.json",
      task: {
        id,
        desc: `Test task ${id}`,
        setup: { files: {} },
        graders: [{ type: "static_analysis" as const, commands: ["tsc"] }],
        trackedMetrics: ["pass_at_1"],
        tags: ["promoted"],
      },
      promotedAt,
      notes: "auto-promoted",
    };
  }

  it("promoteToSuite writes JSON file to suite dir", async () => {
    const suiteDir = join(dir, "suite");
    const candidate = makeCandidate("promoted-abc12345", Date.now());

    const filePath = await promoteToSuite(candidate, suiteDir);

    expect(filePath).toEndWith("promoted-abc12345.json");

    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { id: string };
    expect(parsed.id).toBe("promoted-abc12345");
  });

  it("listCandidates returns sorted candidates from dir", async () => {
    const candidateDir = join(dir, "candidates");
    await mkdir(candidateDir, { recursive: true });

    const now = Date.now();
    const c1 = makeCandidate("cand-aaaa0001", now - 2000);
    const c2 = makeCandidate("cand-bbbb0002", now - 1000);
    const c3 = makeCandidate("cand-cccc0003", now);

    for (const c of [c1, c2, c3]) {
      await writeFile(join(candidateDir, `${c.id}.json`), JSON.stringify(c, null, 2), {
        encoding: "utf-8",
      });
    }

    const results = await listCandidates(candidateDir);

    expect(results.length).toBe(3);
    // Sorted descending by promotedAt: c3 first, c1 last
    expect(results[0]?.id).toBe("cand-cccc0003");
    expect(results[1]?.id).toBe("cand-bbbb0002");
    expect(results[2]?.id).toBe("cand-aaaa0001");
  });
});
