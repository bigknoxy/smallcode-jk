import { describe, expect, it } from "bun:test";
import { applyBatch, isTestFilePath, TEST_FILE_EDIT_REJECTED } from "../src/edit/index.ts";
import { buildTurnPrompt } from "../src/agent/prompt.ts";
import type { AgentState } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { EditBlock } from "../src/edit/types.ts";

// ---------------------------------------------------------------------------
// Anti-fake-green: applyBatch must REJECT edits to test/spec files.
//
// The tests are the oracle. A model that edits a test to make it pass produces a
// false "solved" — the trial grades green while the bug remains. applyBatch
// rejects writes to any test/spec path with status "error" + feedback, and never
// calls writeFile for them. Implementation edits are unaffected.
// ---------------------------------------------------------------------------

function sr(filePath: string): EditBlock {
  return { filePath, search: "const a = 1;", replace: "const a = 2;", format: "search-replace" };
}

function makeIO(disk: Record<string, string>) {
  const writes: Array<{ path: string; content: string }> = [];
  const readFile = async (p: string): Promise<string | null> => disk[p] ?? null;
  const writeFile = async (p: string, content: string): Promise<void> => {
    writes.push({ path: p, content });
    disk[p] = content;
  };
  return { readFile, writeFile, writes };
}

describe("isTestFilePath", () => {
  for (const p of [
    "tests/foo.test.ts",
    "src/foo.test.ts",
    "src/foo.spec.ts",
    "test/foo.ts",
    "__tests__/foo.ts",
    "pkg/tests/bar.test.tsx",
  ]) {
    it(`flags ${p}`, () => expect(isTestFilePath(p)).toBe(true));
  }
  for (const p of ["src/foo.ts", "src/index.js", "lib/testimony.ts", "src/attest.ts"]) {
    it(`allows ${p}`, () => expect(isTestFilePath(p)).toBe(false));
  }
});

describe("applyBatch — test-file edit guard", () => {
  it("rejects an edit to a tests/ file: status error, no write", async () => {
    const { readFile, writeFile, writes } = makeIO({ "tests/m.test.ts": "const a = 1;" });
    const batch = await applyBatch([sr("tests/m.test.ts")], readFile, writeFile);
    expect(batch.allApplied).toBe(false);
    expect(batch.results[0]!.status).toBe("error");
    expect(batch.results[0]!.error).toContain("editing test/spec files is not allowed");
    expect(writes).toHaveLength(0); // oracle untouched
  });

  it("rejects a .spec. file edit", async () => {
    const { readFile, writeFile, writes } = makeIO({ "src/m.spec.ts": "const a = 1;" });
    const batch = await applyBatch([sr("src/m.spec.ts")], readFile, writeFile);
    expect(batch.results[0]!.status).toBe("error");
    expect(writes).toHaveLength(0);
  });

  it("catches a flattened test-path typo (tests.m.test.ts) — no stray write", async () => {
    // Only the real test file exists on disk; the model emitted a dot-flattened path.
    const { readFile, writeFile, writes } = makeIO({ "tests/m.test.ts": "const a = 1;" });
    const batch = await applyBatch([sr("tests.m.test.ts")], readFile, writeFile);
    expect(batch.results[0]!.status).toBe("error");
    expect(writes).toHaveLength(0);
  });

  it("still applies a normal implementation edit", async () => {
    const { readFile, writeFile, writes } = makeIO({ "src/m.ts": "const a = 1;" });
    const batch = await applyBatch([sr("src/m.ts")], readFile, writeFile);
    expect(batch.allApplied).toBe(true);
    expect(batch.results[0]!.status).toBe("applied");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("src/m.ts");
  });

  it("rejects ONLY the test block in a mixed batch; the impl edit applies", async () => {
    const { readFile, writeFile, writes } = makeIO({
      "src/m.ts": "const a = 1;",
      "tests/m.test.ts": "const a = 1;",
    });
    const batch = await applyBatch([sr("src/m.ts"), sr("tests/m.test.ts")], readFile, writeFile);
    expect(batch.allApplied).toBe(false);
    const byPath = Object.fromEntries(batch.results.map((r) => [r.filePath, r.status]));
    expect(byPath["src/m.ts"]).toBe("applied");
    expect(byPath["tests/m.test.ts"]).toBe("error");
    expect(writes.map((w) => w.path)).toEqual(["src/m.ts"]);
  });

});

describe("buildTurnPrompt — test-guard rejection feedback pivots to implementation", () => {
  const state: AgentState = {
    sessionId: "s",
    task: "fix the bug",
    repoRoot: "/tmp/r",
    modelId: "m",
    goals: [{ id: "g", description: "fix src/m.ts", status: "in_progress" }],
    currentGoalIndex: 0,
    status: "running",
    scratchpad: "",
    startedAt: 0,
    updatedAt: 0,
    maxTurns: 10,
    turns: [
      {
        turn: 1,
        goalId: "g",
        prompt: "p",
        rawResponse: "r",
        answer: "a",
        toolCalls: [],
        toolResults: [],
        editBlocks: [],
        applyResults: [
          {
            filePath: "tests/m.test.ts",
            status: "error",
            error: `edit rejected: ${TEST_FILE_EDIT_REJECTED} — the tests are the specification.`,
          },
        ],
        promptTokens: 0,
        completionTokens: 0,
        timestamp: 0,
      },
    ],
  };
  const ctx: ContextBundle = {
    chunks: [{ filePath: "tests/m.test.ts", startLine: 1, endLine: 1, content: "TEST CONTENT", estimatedTokens: 5 }],
    totalTokens: 5,
    tokenBudget: 4096,
    truncated: false,
    query: "q",
  };

  it("tells the model to edit the implementation, NOT re-emit the test file", () => {
    const prompt = buildTurnPrompt(state, ctx);
    expect(prompt).toContain("cannot be edited");
    expect(prompt).toContain("IMPLEMENTATION");
    // The generic recovery must NOT fire: no "re-emit the complete file"
    // instruction and no "The file currently contains:" re-show inside the edit
    // feedback. (The test file may still appear under ## Relevant Context — the
    // model always sees the repo; that is not the recovery instruction.)
    expect(prompt).not.toContain("Re-emit the COMPLETE corrected file");
    expect(prompt).not.toContain("The file currently contains:");
  });
});
