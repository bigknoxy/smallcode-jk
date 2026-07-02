import { describe, expect, it } from "bun:test";
import type { TurnRecord } from "../src/agent/types.ts";
import { summarizeRepairs } from "../src/eval/repair-metrics.ts";

// Minimal turn builder — only applyResults matter to summarizeRepairs.
function turn(applyResults: TurnRecord["applyResults"]): TurnRecord {
  return { turn: 1, applyResults } as unknown as TurnRecord;
}
const applied = (repair?: { strategy: "exact" | "whitespace" | "fuzzy" | "failed"; confidence: number }) =>
  ({ filePath: "a.ts", status: "applied" as const, ...(repair ? { repair } : {}) });

describe("summarizeRepairs", () => {
  it("counts applied edits and repair rate with strategy breakdown", () => {
    const turns = [
      turn([applied()]), // exact (no repair stamp)
      turn([applied({ strategy: "whitespace", confidence: 0.85 })]),
      turn([applied({ strategy: "fuzzy", confidence: 0.9 })]),
    ];
    const s = summarizeRepairs(turns);
    expect(s.appliedEdits).toBe(3);
    expect(s.repaired).toBe(2);
    expect(s.repairRate).toBeCloseTo(2 / 3, 5);
    expect(s.byStrategy.whitespace).toBe(1);
    expect(s.byStrategy.fuzzy).toBe(1);
  });

  it("ignores non-applied results (rejected/not_found never count)", () => {
    const turns = [
      turn([{ filePath: "a.ts", status: "rejected" as const } as never]),
      turn([{ filePath: "a.ts", status: "not_found" as const } as never]),
      turn([applied()]),
    ];
    const s = summarizeRepairs(turns);
    expect(s.appliedEdits).toBe(1);
    expect(s.repaired).toBe(0);
    expect(s.repairRate).toBe(0);
  });

  it("returns rate 0 (not NaN) when nothing was applied", () => {
    const s = summarizeRepairs([turn([])]);
    expect(s.appliedEdits).toBe(0);
    expect(s.repairRate).toBe(0);
  });

  it("aggregates across many turns", () => {
    const turns = [
      turn([applied(), applied({ strategy: "whitespace", confidence: 0.8 })]),
      turn([applied({ strategy: "whitespace", confidence: 0.85 })]),
    ];
    const s = summarizeRepairs(turns);
    expect(s.appliedEdits).toBe(3);
    expect(s.byStrategy.whitespace).toBe(2);
    expect(s.repairRate).toBeCloseTo(2 / 3, 5);
  });
});
