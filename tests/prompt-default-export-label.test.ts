import { describe, expect, it } from "bun:test";
import { buildTurnPrompt } from "../src/agent/prompt.ts";
import type { AgentState } from "../src/agent/types.ts";
import type { ContextBundle, TargetFile } from "../src/context/types.ts";

// ---------------------------------------------------------------------------
// Anonymous `export default function (…)` edit-target labeling.
//
// The extractor names an anonymous default export with the synthetic anchor
// "default" so the PATCH applier can find it. But telling a small model to edit
// "the `default` function" names nothing visible in the source (there is no
// `function default`) — on real-repo default exports (mri, klona, dequal) that
// reads as an opaque instruction and costs localization confidence (mri-flags
// 0/10). The directive prose must instead reference the recognizable
// `export default function`, while the PATCH FUNCTION: anchor stays "default".
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    sessionId: "s1",
    task: "Fix the inverted lookahead in the mri parser",
    repoRoot: "/tmp/repo",
    modelId: "test-model",
    goals: [{ id: "goal-1", description: "Fix the val= line in src/index.js", status: "in_progress" }],
    currentGoalIndex: 0,
    turns: [],
    status: "running",
    scratchpad: "",
    startedAt: 0,
    updatedAt: 0,
    maxTurns: 10,
    ...overrides,
  };
}

function makeContext(targetFile: TargetFile): ContextBundle {
  return {
    chunks: [],
    totalTokens: 0,
    tokenBudget: 4096,
    truncated: false,
    query: "goal",
    targetFile,
  };
}

const defaultTarget = (overrides: Partial<TargetFile> = {}): TargetFile => ({
  path: "src/index.js",
  lineCount: 119,
  format: "patch",
  functionName: "default",
  functionLineCount: 105, // >= DIFF_MIN_FN default 30 -> SR (minimal-diff) mode
  ...overrides,
});

describe("buildTurnPrompt — default-export edit target", () => {
  it("SR mode: references `export default function`, never 'the `default` function'", () => {
    const prompt = buildTurnPrompt(makeState(), makeContext(defaultTarget()));
    expect(prompt).toContain("export default function");
    expect(prompt).not.toContain("`default` function");
  });

  it("PATCH mode (small default-export file): keeps FUNCTION: default anchor but valid example syntax", () => {
    // functionLineCount below DIFF_MIN_FN forces whole-function PATCH mode.
    const prompt = buildTurnPrompt(
      makeState(),
      makeContext(defaultTarget({ lineCount: 95, functionLineCount: 12 })),
    );
    // The applier anchors on the synthetic name — must remain.
    expect(prompt).toContain("FUNCTION: default");
    // The example must be valid JS, not `export function default(...)`.
    expect(prompt).toContain("export default function (...)");
    expect(prompt).not.toContain("export function default(");
  });

  it("named function targets are unaffected (still 'the `name` function')", () => {
    const prompt = buildTurnPrompt(
      makeState(),
      makeContext(defaultTarget({ functionName: "klona", functionLineCount: 60 })),
    );
    expect(prompt).toContain("`klona` function");
    expect(prompt).not.toContain("export default function");
  });
});
