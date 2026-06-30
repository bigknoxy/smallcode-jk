import { test, expect, describe } from "bun:test";
import { collectMetrics, averageMetrics } from "../src/eval/metrics.ts";
import type { Transcript } from "../src/eval/types.ts";
import type { TurnRecord } from "../src/agent/types.ts";

function turn(applyStatuses: string[]): TurnRecord {
  return {
    turn: 1,
    goalId: "g",
    prompt: "",
    rawResponse: "",
    answer: "",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: applyStatuses.map((status) => ({ status }) as any),
    promptTokens: 0,
    completionTokens: 0,
    timestamp: 0,
  };
}

function transcript(turns: TurnRecord[]): Transcript {
  return {
    id: "t",
    sessionId: "s",
    taskId: "task",
    trialIndex: 0,
    modelId: "m",
    turns,
    outcome: "failed",
    startedAt: 0,
    finishedAt: 1,
  };
}

describe("editFormatOk metric (R5 Aider-style correct-edit-format)", () => {
  test("1 when any turn applied an edit cleanly", () => {
    expect(collectMetrics(transcript([turn(["error"]), turn(["applied"])])).editFormatOk).toBe(1);
  });

  test("0 when no edit ever applied (only errors / none)", () => {
    expect(collectMetrics(transcript([turn(["error"]), turn([])])).editFormatOk).toBe(0);
  });

  test("0 for an empty transcript", () => {
    expect(collectMetrics(transcript([])).editFormatOk).toBe(0);
  });

  test("averageMetrics yields the edit-format-% across trials", () => {
    const ok = collectMetrics(transcript([turn(["applied"])]));
    const bad = collectMetrics(transcript([turn(["error"])]));
    // 3 ok + 1 bad → 0.75
    const avg = averageMetrics([ok, ok, ok, bad]);
    expect(avg.editFormatOk).toBeCloseTo(0.75, 5);
  });
});
