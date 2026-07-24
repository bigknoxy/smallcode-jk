import { describe, expect, it } from "bun:test";
import { type RepairArchetype, runArchetypeRepair } from "../src/repair/archetype.ts";
import type { AgentState } from "../src/agent/types.ts";
import type { OracleVerdict } from "../src/verify/oracle.ts";

/**
 * E4-T1 — the pluggable archetype driver. A brand-new archetype is just a
 * `targets`+`candidatesFor` pair; the shared driver owns the write→oracle→revert→
 * keep-first-green loop + throw-containment. These tests exercise that contract
 * with a trivial in-memory archetype (no operator/literal specifics).
 */

function memFs(initial: Record<string, string>) {
  const disk = new Map(Object.entries(initial));
  return {
    disk,
    read: async (p: string): Promise<string | null> => disk.get(p) ?? null,
    write: async (p: string, c: string): Promise<void> => void disk.set(p, c),
  };
}

const state = (over: Partial<AgentState> = {}): AgentState =>
  ({ repoRoot: "/repo", lockedTargetPath: "a.ts", turns: [], ...over }) as unknown as AgentState;
const baseline = { failingIds: new Set<string>(), hadAnyTests: true, redCount: 1, loadError: false };

// A trivial archetype: try replacing "BUG" with each of a few fixes.
const fixesArchetype = (fixes: string[]): RepairArchetype => ({
  logName: "test-archetype",
  targets: (s) => (s.lockedTargetPath ? [s.lockedTargetPath] : []),
  candidatesFor: (_s, _p, current) =>
    fixes.map((f, i) => ({ candidate: current.replace("BUG", f), label: `try ${f}`, line: i + 1 })),
});

const solved = { outcome: "solved" } as OracleVerdict;
const failing = { outcome: "failing", checks: [], feedback: "" } as OracleVerdict;

describe("runArchetypeRepair", () => {
  it("keeps the FIRST candidate that greens the oracle; leaves it on disk", async () => {
    const fs = memFs({ "a.ts": "const x = BUG;" });
    // Oracle greens only when the file contains "GOOD".
    const oracle = async (): Promise<OracleVerdict> =>
      (fs.disk.get("a.ts") ?? "").includes("GOOD") ? solved : failing;
    const r = await runArchetypeRepair(fixesArchetype(["BAD", "GOOD", "ALSOGOOD"]), state(), baseline, fs.read, fs.write, oracle);
    expect(r).not.toBeNull();
    expect(r?.label).toBe("try GOOD");
    expect(r?.attempts).toBe(2); // BAD (miss) then GOOD (win)
    expect(fs.disk.get("a.ts")).toBe("const x = GOOD;"); // winner left on disk
  });

  it("reverts every miss and returns null when nothing greens", async () => {
    const fs = memFs({ "a.ts": "const x = BUG;" });
    const oracle = async (): Promise<OracleVerdict> => failing; // never green
    const r = await runArchetypeRepair(fixesArchetype(["A", "B"]), state(), baseline, fs.read, fs.write, oracle);
    expect(r).toBeNull();
    expect(fs.disk.get("a.ts")).toBe("const x = BUG;"); // restored to the model's edit
  });

  it("contains a throw: restores the file and returns null (guard backstop)", async () => {
    const fs = memFs({ "a.ts": "const x = BUG;" });
    const oracle = async (): Promise<OracleVerdict> => {
      throw new Error("bun test timeout");
    };
    const r = await runArchetypeRepair(fixesArchetype(["A"]), state(), baseline, fs.read, fs.write, oracle);
    expect(r).toBeNull();
    expect(fs.disk.get("a.ts")).toBe("const x = BUG;"); // never orphans a half-tried candidate
  });

  it("shares one attempt budget across multiple targets via attemptsSoFar", async () => {
    const fs = memFs({ "a.ts": "BUG", "b.ts": "BUG" });
    // Each file offers 1 candidate but only up to a total budget of 1.
    const budgeted: RepairArchetype = {
      logName: "budgeted",
      targets: () => ["a.ts", "b.ts"],
      candidatesFor: (_s, p, current, attemptsSoFar) =>
        attemptsSoFar >= 1 ? [] : [{ candidate: current.replace("BUG", `fix-${p}`), label: p, line: 1 }],
    };
    const oracle = async (): Promise<OracleVerdict> => failing; // never green → exhausts budget
    await runArchetypeRepair(budgeted, state(), baseline, fs.read, fs.write, oracle);
    // a.ts consumed the single budget unit (tried+reverted); b.ts got [] → untouched attempt.
    expect(fs.disk.get("a.ts")).toBe("BUG"); // reverted
    expect(fs.disk.get("b.ts")).toBe("BUG"); // never tried (budget spent)
  });
});
