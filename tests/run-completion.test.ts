/**
 * Unit tests for classifyCompletion — the honest completion verdict helper.
 *
 * This is the regression guard for the critical false-solve bug: a run where
 * the model never produced a valid fix STILL printing "✓ Done in 15 turns".
 * Every status × verified/not-verified combo is covered.
 */
import { describe, expect, it } from "bun:test";
import { classifyCompletion } from "../src/cli/commands/run.ts";

const STATE_PATH = "/tmp/test/.smallcode/state.json";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function classify(
  status: "running" | "done" | "failed" | "max_turns" | "abandoned",
  verified?: boolean,
) {
  return classifyCompletion({ status, verified }, STATE_PATH);
}

// ---------------------------------------------------------------------------
// The critical false-solve cases
// ---------------------------------------------------------------------------

describe("classifyCompletion — critical false-solve guard", () => {
  it("status=done + verified=false → NOT ok (was the false-solve bug)", () => {
    const result = classify("done", false);
    expect(result.ok).toBe(false);
    expect(result.tone).toBe("warn");
    expect(result.message).toContain(STATE_PATH);
  });

  it("status=done + verified=undefined → NOT ok (model called finish() unverified)", () => {
    const result = classify("done", undefined);
    expect(result.ok).toBe(false);
    expect(result.tone).toBe("warn");
    expect(result.message).toContain(STATE_PATH);
  });

  it("status=max_turns → NOT ok, tone=error", () => {
    const result = classify("max_turns");
    expect(result.ok).toBe(false);
    expect(result.tone).toBe("error");
    expect(result.message).toContain("max turns");
    expect(result.message).toContain(STATE_PATH);
  });
});

// ---------------------------------------------------------------------------
// The one real success case
// ---------------------------------------------------------------------------

describe("classifyCompletion — genuine success", () => {
  it("status=done + verified=true → ok, tone=success", () => {
    const result = classify("done", true);
    expect(result.ok).toBe(true);
    expect(result.tone).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// All other non-success statuses
// ---------------------------------------------------------------------------

describe("classifyCompletion — non-success statuses", () => {
  it("status=failed → NOT ok, tone=error", () => {
    const result = classify("failed");
    expect(result.ok).toBe(false);
    expect(result.tone).toBe("error");
    expect(result.message).toContain(STATE_PATH);
  });

  it("status=abandoned → NOT ok, tone=error", () => {
    const result = classify("abandoned");
    expect(result.ok).toBe(false);
    expect(result.tone).toBe("error");
    expect(result.message).toContain("abandoned");
    expect(result.message).toContain(STATE_PATH);
  });

  it("status=running → NOT ok, tone=error (loop exited early unexpectedly)", () => {
    const result = classify("running");
    expect(result.ok).toBe(false);
    expect(result.tone).toBe("error");
    expect(result.message).toContain("running");
    expect(result.message).toContain(STATE_PATH);
  });
});

// ---------------------------------------------------------------------------
// max_turns + verified combos (verified should not rescue a max_turns exit)
// ---------------------------------------------------------------------------

describe("classifyCompletion — max_turns ignores verified flag", () => {
  it("status=max_turns + verified=true is still NOT ok", () => {
    // Should never happen in practice (verified only set on solved), but must be safe.
    const result = classify("max_turns", true);
    expect(result.ok).toBe(false);
    expect(result.tone).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Table: all status × verified combos summarised
// ---------------------------------------------------------------------------

describe("classifyCompletion — full status × verified table", () => {
  const cases: Array<{
    status: "running" | "done" | "failed" | "max_turns" | "abandoned";
    verified: boolean | undefined;
    expectedOk: boolean;
    expectedTone: "success" | "warn" | "error";
  }> = [
    { status: "done",      verified: true,      expectedOk: true,  expectedTone: "success" },
    { status: "done",      verified: false,     expectedOk: false, expectedTone: "warn"    },
    { status: "done",      verified: undefined, expectedOk: false, expectedTone: "warn"    },
    { status: "max_turns", verified: undefined, expectedOk: false, expectedTone: "error"   },
    { status: "max_turns", verified: true,      expectedOk: false, expectedTone: "error"   },
    { status: "failed",    verified: undefined, expectedOk: false, expectedTone: "error"   },
    { status: "failed",    verified: true,      expectedOk: false, expectedTone: "error"   },
    { status: "abandoned", verified: undefined, expectedOk: false, expectedTone: "error"   },
    { status: "running",   verified: undefined, expectedOk: false, expectedTone: "error"   },
  ];

  for (const c of cases) {
    it(`status=${c.status} verified=${c.verified} → ok=${c.expectedOk} tone=${c.expectedTone}`, () => {
      const result = classify(c.status, c.verified);
      expect(result.ok).toBe(c.expectedOk);
      expect(result.tone).toBe(c.expectedTone);
    });
  }
});
