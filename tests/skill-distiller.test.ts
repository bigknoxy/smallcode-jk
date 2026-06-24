/**
 * Tests for src/improve/skill-distiller.ts
 *
 * All tests are pure/mocked — no model calls, no Ollama, no localhost:11434.
 */

import { describe, expect, it } from "bun:test";
import type { Transcript } from "../src/eval/types.ts";
import { distillSkill } from "../src/improve/skill-distiller.ts";
import type { SessionLogEntry } from "../src/improve/types.ts";

// ---------------------------------------------------------------------------
// Minimal in-memory TranscriptStore stub
// ---------------------------------------------------------------------------

class InMemoryTranscriptStore {
  private map = new Map<string, Transcript>();

  add(transcript: Transcript): void {
    this.map.set(transcript.id, transcript);
  }

  async load(id: string): Promise<Transcript | null> {
    return this.map.get(id) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSession(
  id: string,
  outcome: SessionLogEntry["outcome"] = "done",
): SessionLogEntry {
  return {
    sessionId: id,
    taskDesc: `Task ${id}`,
    repoRoot: "/tmp/repo",
    modelId: "test-model",
    outcome,
    nTurns: 2,
    nTokens: 500,
    latencyMs: 3000,
    // Transcript path: distiller extracts "trans-<id>" as the transcript ID.
    transcriptPath: `/evals/transcripts/task-1/trans-${id}.json`,
    timestamp: Date.now(),
  };
}

function makeTranscript(id: string, toolSequence: string[]): Transcript {
  return {
    id,
    sessionId: `sess-${id}`,
    taskId: "task-1",
    trialIndex: 0,
    modelId: "test-model",
    turns: [
      {
        turn: 0,
        goalId: "goal-1",
        prompt: "fix it",
        rawResponse: "ok",
        answer: "ok",
        toolCalls: toolSequence.map((name) => ({
          name: name as import("../src/agent/types.ts").ToolName,
          args: name === "run_command" ? { cmd: "bun test" } : {},
        })),
        toolResults: toolSequence.map((name) => ({
          name: name as import("../src/agent/types.ts").ToolName,
          success: true,
          output: "",
        })),
        editBlocks: [],
        applyResults: [],
        promptTokens: 100,
        completionTokens: 50,
        timestamp: Date.now(),
      },
    ],
    outcome: "passed",
    startedAt: Date.now() - 5000,
    finishedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("distillSkill — empty sessions", () => {
  it("returns stub string when no sessions provided", async () => {
    const store = new InMemoryTranscriptStore();
    const result = await distillSkill([], { transcriptStore: store as never });
    expect(result).toContain("No passing sessions yet");
  });
});

describe("distillSkill — sessions with no matching transcripts", () => {
  it("returns stub when transcripts cannot be loaded", async () => {
    const store = new InMemoryTranscriptStore();
    // Sessions exist but no transcripts in store.
    const sessions = [makeSession("aaa"), makeSession("bbb")];
    const result = await distillSkill(sessions, { transcriptStore: store as never });
    expect(result).toContain("No passing sessions yet");
  });
});

describe("distillSkill — passing sessions with transcripts", () => {
  it("includes passing session count in output", async () => {
    const store = new InMemoryTranscriptStore();
    const s1 = makeSession("s01");
    const t1 = makeTranscript("trans-s01", ["read_file", "run_tests", "finish"]);
    store.add(t1);

    const result = await distillSkill([s1], { transcriptStore: store as never });
    expect(result).toContain("1 passing session");
  });

  it("includes dominant tool pattern in output", async () => {
    const store = new InMemoryTranscriptStore();
    const toolSeq = ["read_file", "run_tests", "finish"];
    for (const id of ["s01", "s02", "s03"]) {
      const t = makeTranscript(`trans-${id}`, toolSeq);
      store.add(t);
    }
    const sessions = ["s01", "s02", "s03"].map((id) => makeSession(id));

    const result = await distillSkill(sessions, { transcriptStore: store as never });
    expect(result).toContain("read_file");
    expect(result).toContain("run_tests");
    expect(result).toContain("finish");
  });

  it("mentions bun test when run_command with cmd=bun test is used", async () => {
    const store = new InMemoryTranscriptStore();
    const s1 = makeSession("s01");
    const t1 = makeTranscript("trans-s01", ["read_file", "run_command", "finish"]);
    // Override the run_command arg in the transcript.
    (t1.turns[0]!.toolCalls[1] as { name: string; args: { cmd: string } }).args.cmd = "bun test";
    store.add(t1);

    const result = await distillSkill([s1], { transcriptStore: store as never });
    expect(result).toContain("bun test");
  });

  it("is deterministic — same input produces same output", async () => {
    const store = new InMemoryTranscriptStore();
    const sessions: SessionLogEntry[] = [];
    for (const id of ["s01", "s02", "s03"]) {
      const s = makeSession(id);
      const t = makeTranscript(`trans-${id}`, ["read_file", "run_tests", "finish"]);
      store.add(t);
      sessions.push(s);
    }

    const result1 = await distillSkill(sessions, { transcriptStore: store as never });
    const result2 = await distillSkill(sessions, { transcriptStore: store as never });
    expect(result1).toBe(result2);
  });

  it("respects maxSessions cap", async () => {
    const store = new InMemoryTranscriptStore();
    const sessions: SessionLogEntry[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `s${String(i).padStart(2, "0")}`;
      const s = makeSession(id);
      const t = makeTranscript(`trans-${id}`, ["read_file", "finish"]);
      store.add(t);
      sessions.push(s);
    }

    // With maxSessions=3, only 3 transcripts are read.
    const result = await distillSkill(sessions, { transcriptStore: store as never, maxSessions: 3 });
    expect(result).toContain("3 passing session");
  });

  it("includes finish reminder in all outputs", async () => {
    const store = new InMemoryTranscriptStore();
    const s1 = makeSession("s01");
    const t1 = makeTranscript("trans-s01", ["read_file", "finish"]);
    store.add(t1);

    const result = await distillSkill([s1], { transcriptStore: store as never });
    expect(result).toContain("run_tests");
    expect(result).toContain("finish");
  });
});

describe("distillSkill — mixed sessions (only done counted)", () => {
  it("handles sessions where some transcripts are missing gracefully", async () => {
    const store = new InMemoryTranscriptStore();
    const s1 = makeSession("s01");
    const s2 = makeSession("s02"); // no transcript added for s02
    const t1 = makeTranscript("trans-s01", ["read_file", "finish"]);
    store.add(t1);

    const result = await distillSkill([s1, s2], { transcriptStore: store as never });
    // Still gets output from s01's transcript.
    expect(result).toContain("1 passing session");
  });
});
