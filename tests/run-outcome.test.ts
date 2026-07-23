/**
 * E1-T5 — honest run outcome. `summarizeOutcome` derives WHY a run failed / HOW
 * it was solved from the finished state, and the two renderers turn that into the
 * user-facing attribution / failure block. Pure, deterministic.
 */
import { describe, expect, it } from "bun:test";
import type { AgentState } from "../src/agent/types.ts";
import {
  renderFailureBlock,
  renderSolvedAttribution,
  summarizeOutcome,
} from "../src/cli/commands/run.ts";

function turn(over: Partial<AgentState["turns"][number]> = {}): AgentState["turns"][number] {
  return {
    turn: 1,
    goalId: "g",
    prompt: "",
    rawResponse: "",
    answer: "",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 0,
    completionTokens: 0,
    timestamp: 0,
    ...over,
  } as AgentState["turns"][number];
}

type S = Pick<AgentState, "status" | "verified" | "turns" | "finalStateReverted">;
const base = (over: Partial<S>): S => ({ status: "done", verified: false, turns: [], ...over });

describe("summarizeOutcome — solved attribution", () => {
  it("verified with no rescue/escalation → solved by the model", () => {
    const s = summarizeOutcome(base({ verified: true, turns: [turn()] }));
    expect(s.solved).toBe(true);
    expect(s.mechanism).toBe("model");
    expect(renderSolvedAttribution(s)).toBe("Solved by the model.");
  });

  it("a turn carrying mutationRepair → harness-rescue attribution (not the model)", () => {
    const s = summarizeOutcome(
      base({ verified: true, turns: [turn({ mutationRepair: { label: "=== → !==", line: 12, attempts: 3 } })] }),
    );
    expect(s.mechanism).toBe("harness-rescue");
    expect(s.mechanismDetail).toBe("=== → !==");
    expect(renderSolvedAttribution(s)).toContain("harness rescue");
    expect(renderSolvedAttribution(s)).toContain("not the model");
  });

  it("escalatedTo set → escalated attribution takes priority", () => {
    const s = summarizeOutcome(base({ verified: true, turns: [turn()] }), "qwen2.5-coder:7b");
    expect(s.mechanism).toBe("escalated");
    expect(renderSolvedAttribution(s)).toBe("Solved after escalating to qwen2.5-coder:7b.");
  });
});

describe("summarizeOutcome — honest failure", () => {
  it("max_turns, no guard → couldn't fix + no edits kept", () => {
    const s = summarizeOutcome(base({ status: "max_turns", turns: [turn()] }));
    expect(s.solved).toBe(false);
    expect(s.mechanism).toBe("none");
    expect(s.reason).toContain("ran out of turns");
    const block = renderFailureBlock(s);
    expect(block[0]).toContain("Could not fix");
    expect(block.some((l) => l.includes("No edits were kept"))).toBe(true);
  });

  it("guard fired → reports the restore, verified flag, and failing tests", () => {
    const s = summarizeOutcome(
      base({
        status: "max_turns",
        turns: [turn()],
        finalStateReverted: {
          newFailures: ["suite > adds two numbers"],
          startRed: 1,
          endRed: 3,
          filesRestored: 2,
          restoreVerified: true,
        },
      }),
    );
    expect(s.guardFired).toBe(true);
    expect(s.restoreVerified).toBe(true);
    expect(s.filesRestored).toBe(2);
    expect(s.failingTests).toEqual(["suite > adds two numbers"]);
    const block = renderFailureBlock(s);
    expect(block.some((l) => l.includes("restored 2 file(s)") && l.includes("restore verified"))).toBe(true);
    expect(block.some((l) => l.includes("Still failing: suite > adds two numbers"))).toBe(true);
  });

  it("guard fired with UNVERIFIED restore → the failure block flags it loudly", () => {
    const s = summarizeOutcome(
      base({
        status: "max_turns",
        turns: [turn()],
        finalStateReverted: { newFailures: [], startRed: 2, endRed: 4, filesRestored: 1, restoreVerified: false },
      }),
    );
    expect(s.restoreVerified).toBe(false);
    expect(renderFailureBlock(s).some((l) => l.includes("restore UNVERIFIED"))).toBe(true);
  });

  it("falls back to a turn diagnostic for failing-test names when the guard didn't fire", () => {
    const s = summarizeOutcome(
      base({
        status: "max_turns",
        turns: [turn({ diagnostic: { assertionId: "parse > handles empty", message: "x", errorType: "AssertionError", raw: "x" } })],
      }),
    );
    expect(s.failingTests).toEqual(["parse > handles empty"]);
  });
});
