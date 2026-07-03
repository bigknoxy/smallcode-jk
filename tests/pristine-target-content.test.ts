import { describe, expect, it } from "bun:test";
import { pristineTargetContent } from "../src/agent/loop.ts";
import type { AgentState, TurnRecord } from "../src/agent/types.ts";
import type { ApplyResult } from "../src/edit/types.ts";

// ---------------------------------------------------------------------------
// Fixture helpers — minimal TurnRecord/AgentState builders. No disk I/O; these
// are hand-built in-memory objects, cast where convenient per project
// convention (see tests/classify-pass-quality.test.ts).
// ---------------------------------------------------------------------------

function makeTurn(applyResults: Partial<ApplyResult>[], overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    goalId: "g1",
    prompt: "prompt",
    rawResponse: "raw",
    answer: "answer",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults,
    promptTokens: 10,
    completionTokens: 10,
    timestamp: Date.now(),
    ...overrides,
  } as unknown as TurnRecord;
}

function makeState(turns: TurnRecord[]): AgentState {
  return { turns } as unknown as AgentState;
}

describe("pristineTargetContent", () => {
  it("returns the earliest applied edit's originalContent (first-edit wins)", () => {
    const state = makeState([
      makeTurn([{ filePath: "src/index.js", status: "applied", originalContent: "PRISTINE" }]),
      makeTurn([{ filePath: "src/index.js", status: "applied", originalContent: "MANGLED" }]),
    ]);
    expect(pristineTargetContent(state, "src/index.js")).toBe("PRISTINE");
  });

  it("matches on effectivePath, not filePath (path-typo rescue)", () => {
    const state = makeState([
      makeTurn([
        {
          filePath: "src.index.js",
          effectivePath: "src/index.js",
          status: "applied",
          originalContent: "P",
        },
      ]),
    ]);
    expect(pristineTargetContent(state, "src/index.js")).toBe("P");
  });

  it("skips non-applied results for the target even with originalContent", () => {
    const state = makeState([
      makeTurn([{ filePath: "src/index.js", status: "error", originalContent: "REJECTED" }]),
      makeTurn([{ filePath: "src/index.js", status: "applied", originalContent: "APPLIED" }]),
    ]);
    expect(pristineTargetContent(state, "src/index.js")).toBe("APPLIED");
  });

  it("skips applied results missing originalContent, later applied one wins", () => {
    const state = makeState([
      makeTurn([{ filePath: "src/index.js", status: "applied", originalContent: undefined }]),
      makeTurn([{ filePath: "src/index.js", status: "applied", originalContent: "SECOND" }]),
    ]);
    expect(pristineTargetContent(state, "src/index.js")).toBe("SECOND");
  });

  it("returns null when no turn edited the target path", () => {
    const state = makeState([
      makeTurn([{ filePath: "src/other.js", status: "applied", originalContent: "X" }]),
    ]);
    expect(pristineTargetContent(state, "src/index.js")).toBeNull();
  });

  it("returns null when edits exist only for a different path", () => {
    const state = makeState([
      makeTurn([
        { filePath: "src/a.js", status: "applied", originalContent: "A" },
        { filePath: "src/b.js", status: "applied", originalContent: "B" },
      ]),
    ]);
    expect(pristineTargetContent(state, "src/c.js")).toBeNull();
  });

  it("returns null for an empty turns array", () => {
    const state = makeState([]);
    expect(pristineTargetContent(state, "src/index.js")).toBeNull();
  });
});
