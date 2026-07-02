import { describe, expect, it } from "bun:test";
import { classifyPassQuality, classifyTranscripts } from "../scripts/classify-pass-quality.ts";
import type { TurnRecord } from "../src/agent/types.ts";
import type { Transcript } from "../src/eval/types.ts";

// ---------------------------------------------------------------------------
// Fixture helpers — minimal TurnRecord/Transcript builders. No disk I/O; these
// are hand-built in-memory objects, cast where convenient per project
// convention (see e.g. tests/agent-loop.test.ts style).
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<TurnRecord> & { turn: number }): TurnRecord {
  return {
    goalId: "g1",
    prompt: "prompt",
    rawResponse: "raw",
    answer: "answer",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 10,
    completionTokens: 10,
    timestamp: Date.now(),
    ...overrides,
  } as unknown as TurnRecord;
}

function makeTranscript(turns: TurnRecord[], outcome: Transcript["outcome"] = "passed"): Transcript {
  return {
    id: "t1",
    sessionId: "s1",
    taskId: "task-a",
    trialIndex: 0,
    modelId: "qwen2.5-coder:3b",
    turns,
    outcome,
    startedAt: 0,
    finishedAt: 1000,
  } as unknown as Transcript;
}

const appliedEdit = [{ filePath: "src/foo.ts", status: "applied" as const, diff: "diff" }];
const diagnostic = { assertionId: "test > case", message: "expected 1 got 2", raw: "raw failure" };

describe("classifyPassQuality", () => {
  it("classifies a clean 1-turn pass with a diagnostic as ideal", () => {
    const turns = [
      makeTurn({ turn: 1, diagnostic, applyResults: appliedEdit }),
    ];
    const result = classifyPassQuality(makeTranscript(turns));
    expect(result.quality).toBe("ideal");
  });

  it("classifies >=2 same-signature revert cycles as lucky (churn)", () => {
    const turns = [
      makeTurn({ turn: 1, diagnostic, failureSignature: "sig-A" }),
      makeTurn({
        turn: 2,
        failureSignature: "sig-A",
        reverted: { newFailures: ["a.test.ts"] },
      }),
      makeTurn({
        turn: 3,
        failureSignature: "sig-A",
        reverted: { newFailures: ["a.test.ts"] },
      }),
      makeTurn({ turn: 4, applyResults: appliedEdit }),
    ];
    const result = classifyPassQuality(makeTranscript(turns));
    expect(result.quality).toBe("lucky");
    expect(result.signals.some((s) => s.startsWith("churn"))).toBe(true);
  });

  it("classifies a STRUGGLED pass with no diagnostic anywhere as lucky (never localized)", () => {
    // The run failed at least once (recorded failure signatures) yet no turn
    // ever carried a diagnostic — thrashed toward green without diagnosing.
    const turns = [
      makeTurn({ turn: 1, failureSignature: "sig-A" }),
      makeTurn({ turn: 2, failureSignature: "sig-B" }),
      makeTurn({ turn: 3, applyResults: appliedEdit }),
    ];
    const result = classifyPassQuality(makeTranscript(turns));
    expect(result.quality).toBe("lucky");
    expect(result.signals.some((s) => s.startsWith("never-localized"))).toBe(true);
  });

  it("classifies a clean 1-turn solve with NO diagnostic as ideal, not lucky (real-data case)", () => {
    // Regression guard for the false positive real-transcript validation caught:
    // a stack-trace-localized bug the model fixes in ONE turn never fails, so it
    // legitimately has no diagnostic — that is the BEST case, not a lucky one.
    const turns = [makeTurn({ turn: 1, applyResults: appliedEdit })];
    const result = classifyPassQuality(makeTranscript(turns));
    expect(result.quality).toBe("ideal");
    expect(result.signals.some((s) => s.startsWith("never-localized"))).toBe(false);
  });

  it("classifies a clean diagnose→fix (one baseline failure, no reverts) as ideal, not lucky (dequal forensic)", () => {
    // Regression guard for the realrepo-dequal-multifile forensic false positive:
    // a clean 2-turn solve — turn 1 sees the red baseline (one failure signature
    // + diagnostic), turn 2 applies the fix — was mislabeled Lucky via
    // untargeted-fix, because the SOLVING turn naturally has no diagnostic (it
    // succeeded). A single persistent baseline signature + no reverts is NOT
    // "struggling", so the blind-luck signals must not fire.
    const turns = [
      makeTurn({ turn: 1, failureSignature: "sig-A", diagnostic }),
      makeTurn({ turn: 2, applyResults: appliedEdit }),
    ];
    const result = classifyPassQuality(makeTranscript(turns));
    expect(result.quality).toBe("ideal");
    expect(result.signals.some((s) => s.startsWith("untargeted-fix"))).toBe(false);
  });

  it("still flags untargeted-fix when the run actually churned (a reverted attempt)", () => {
    // The signal must survive for genuine thrashing: a reverted attempt, then a
    // fix on a turn that carried no fresh diagnostic (dequal trials 1 & 2).
    const turns = [
      makeTurn({ turn: 1, failureSignature: "sig-A", diagnostic }),
      makeTurn({ turn: 2, failureSignature: "sig-A", reverted: { newFailures: ["x"] }, diagnostic }),
      makeTurn({ turn: 3, applyResults: appliedEdit }),
    ];
    const result = classifyPassQuality(makeTranscript(turns));
    expect(result.quality).toBe("lucky");
    expect(result.signals.some((s) => s.startsWith("untargeted-fix"))).toBe(true);
  });

  it("classifies a middling pass (diagnosis present but not on the solving edit, many turns) as solid", () => {
    const turns = [
      makeTurn({ turn: 1, diagnostic }),
      makeTurn({ turn: 2 }),
      makeTurn({ turn: 3 }),
      makeTurn({ turn: 4 }),
      makeTurn({ turn: 5, applyResults: appliedEdit, diagnostic }),
    ];
    const result = classifyPassQuality(makeTranscript(turns));
    // Solving turn (5) HAS a diagnostic, so the untargeted-fix signal doesn't
    // fire, and anyDiagnostic is true so never-localized doesn't fire either
    // — but 5 turns exceeds IDEAL_MAX_TURNS, so it's not Ideal. Solid.
    expect(result.quality).toBe("solid");
  });

  it("excludes a failed transcript from classifyTranscripts", () => {
    const turns = [makeTurn({ turn: 1, diagnostic, applyResults: appliedEdit })];
    const passed = makeTranscript(turns, "passed");
    const failed = makeTranscript([makeTurn({ turn: 1 })], "failed");
    const classified = classifyTranscripts([passed, failed]);
    expect(classified.length).toBe(1);
    expect(classified[0]?.transcript.outcome).toBe("passed");
  });
});
