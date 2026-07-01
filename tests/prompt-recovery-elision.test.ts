import { describe, expect, it } from "bun:test";
import { buildTurnPrompt } from "../src/agent/index.ts";
import type { AgentConfig, AgentState, TurnRecord } from "../src/agent/types.ts";
import type { ContextBundle, ContextChunk, TargetFile } from "../src/context/types.ts";
import { ELISION_DETECTED } from "../src/edit/index.ts";

// ---------------------------------------------------------------------------
// Regression test for the #1 dogfood usability blocker: a model told to PATCH
// one function instead re-emits the WHOLE FILE abbreviated with `// ...`
// elision. The truncation guard correctly rejects it (no corruption), but the
// OLD recovery prompt re-showed the whole file and said "don't emit the whole
// file" — which is exactly the pattern that produced the mistake, so the model
// repeated it every turn and never landed an edit (max_turns, zero progress).
//
// Fix: `truncationReason` now detects elision markers precisely
// (`findElisionMarker` / `ELISION_DETECTED`), and `buildTurnPrompt` renders a
// dedicated forced-recovery branch for this exact failure shape — offering
// ONLY the target function's current text (via `extractFunctionSource`) and an
// explicit copy-pasteable SEARCH/REPLACE template, escalating wording on
// repeat. This is a prompt-level unit test (no model/provider involved).
// ---------------------------------------------------------------------------

const FILE_CONTENT = `export function unrelated() {
  return 1;
}

export function addTwo(a, b) {
  return a + b; // BUG: should handle carry
}

export function alsoUnrelated() {
  return 2;
}
`;

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    repoRoot: "/tmp/test",
    modelId: "test-model",
    maxTurns: 10,
    bestOfN: 1,
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  const config = makeConfig({ repoRoot: overrides.repoRoot ?? "/tmp/test" });
  return {
    sessionId: "test-session",
    task: "fix addTwo to handle carry",
    repoRoot: config.repoRoot,
    modelId: config.modelId,
    goals: [{ id: "goal-1", description: "fix addTwo", status: "in_progress" }],
    currentGoalIndex: 0,
    turns: [],
    status: "running",
    scratchpad: "",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    maxTurns: 10,
    ...overrides,
  };
}

function makeTargetFile(overrides: Partial<TargetFile> = {}): TargetFile {
  return {
    path: "src/math.ts",
    lineCount: FILE_CONTENT.split("\n").length,
    format: "patch",
    functionName: "addTwo",
    functionLineCount: 3,
    ...overrides,
  };
}

function makeChunk(overrides: Partial<ContextChunk> = {}): ContextChunk {
  return {
    filePath: "src/math.ts",
    startLine: 1,
    endLine: FILE_CONTENT.split("\n").length,
    content: FILE_CONTENT,
    estimatedTokens: 100,
    pinned: true,
    ...overrides,
  };
}

function makeContext(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    chunks: [makeChunk()],
    totalTokens: 100,
    tokenBudget: 2048,
    truncated: false,
    query: "goal",
    targetFile: makeTargetFile(),
    ...overrides,
  };
}

/** Turn where the model answered with a whole-file-shaped block (search === "")
 * for a PATCH-target file, and the elision guard rejected it. */
function makeWholeFileMismatchTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turn: 1,
    goalId: "goal-1",
    prompt: "test prompt",
    rawResponse: "raw",
    answer: "answer",
    toolCalls: [],
    toolResults: [],
    editBlocks: [
      {
        filePath: "src/math.ts",
        search: "",
        replace: "export function unrelated() {\n  return 1;\n}\n\n// ... rest of file unchanged\n",
        format: "full-file",
      },
    ],
    applyResults: [
      {
        filePath: "src/math.ts",
        status: "error",
        error: `${ELISION_DETECTED} (\`// ... rest of file unchanged\`) — this is an ABBREVIATED file, not the complete one`,
      },
    ],
    promptTokens: 10,
    completionTokens: 20,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("buildTurnPrompt — whole-file-vs-PATCH-target recovery", () => {
  it("forces a SEARCH/REPLACE template instead of re-showing the whole file", () => {
    const state = makeState();
    state.turns = [makeWholeFileMismatchTurn()];
    const prompt = buildTurnPrompt(state, makeContext());

    expect(prompt).toContain("Do NOT re-emit the file");
    expect(prompt).toContain("Do NOT use `// ...`");
    expect(prompt).toContain("<<<<<<< SEARCH");
    expect(prompt).toContain(">>>>>>> REPLACE");
  });

  it("shows ONLY the target function body (not the whole file) inside the recovery block", () => {
    const state = makeState();
    state.turns = [makeWholeFileMismatchTurn()];
    const prompt = buildTurnPrompt(state, makeContext());

    expect(prompt).toContain("addTwo");
    expect(prompt).toContain("return a + b; // BUG: should handle carry");
    // Scope the "no whole-file dump" assertion to the recovery block itself —
    // the separate "## Relevant Context" section always pins the full file
    // regardless of this fix, so check only the text between the recovery
    // instruction and the next top-level section.
    const recoveryStart = prompt.indexOf("Do NOT re-emit the file");
    const recoveryEnd = prompt.indexOf("## Relevant Context");
    const recoveryBlock = prompt.slice(recoveryStart, recoveryEnd);
    expect(recoveryBlock).not.toContain("alsoUnrelated");
    expect(recoveryBlock).not.toContain("unrelated()");
  });

  it("does NOT fire this branch for a normal (non-mismatched) apply failure", () => {
    const state = makeState();
    state.turns = [
      makeWholeFileMismatchTurn({
        editBlocks: [
          {
            filePath: "src/math.ts",
            search: "  return a + b; // BUG: should handle carry",
            replace: "  return a + b;",
            format: "patch-function",
          },
        ],
        applyResults: [
          {
            filePath: "src/math.ts",
            status: "not_found",
            error: "SEARCH text not found in file",
          },
        ],
      }),
    ];
    const prompt = buildTurnPrompt(state, makeContext());

    expect(prompt).not.toContain("Do NOT re-emit the file");
  });

  it("escalates wording on a second consecutive whole-file mismatch", () => {
    const state = makeState();
    state.turns = [
      makeWholeFileMismatchTurn({ turn: 1 }),
      makeWholeFileMismatchTurn({ turn: 2 }),
    ];
    const prompt = buildTurnPrompt(state, makeContext());

    expect(prompt).toContain("SAME mistake again");
    expect(prompt).toContain("FINAL chance");
  });

  it("does not escalate on the first (only) occurrence", () => {
    const state = makeState();
    state.turns = [makeWholeFileMismatchTurn()];
    const prompt = buildTurnPrompt(state, makeContext());

    expect(prompt).not.toContain("SAME mistake again");
  });
});
