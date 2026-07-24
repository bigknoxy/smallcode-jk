import { describe, expect, it } from "bun:test";
import { enumerateBooleanMutations } from "../src/repair/boolean-mutation.ts";
import { type RepairArchetype, runArchetypeRepair } from "../src/repair/archetype.ts";
import type { AgentState } from "../src/agent/types.ts";
import type { OracleVerdict } from "../src/verify/oracle.ts";

/**
 * E4-T2 — boolean-mutation archetype (first new archetype on the E4-T1 interface).
 * Pure enumerator + the driver behavior, both deterministic.
 */
describe("enumerateBooleanMutations", () => {
  it("flips each standalone true/false, in file order, with a labeled line", () => {
    const src = "function f() {\n  return true;\n}\nconst ok = false;\n";
    const { mutations, totalFound } = enumerateBooleanMutations(src);
    expect(totalFound).toBe(2);
    expect(mutations[0]).toMatchObject({ label: "boolean true->false", line: 2 });
    expect(mutations[0]?.candidate).toContain("return false;");
    expect(mutations[1]).toMatchObject({ label: "boolean false->true", line: 4 });
    expect(mutations[1]?.candidate).toContain("const ok = true;");
  });

  it("never matches a boolean embedded in an identifier or property", () => {
    const src = "const trueish = 1; const isFalse = 2; obj.true; falsey();";
    expect(enumerateBooleanMutations(src).totalFound).toBe(0);
  });

  it("is INERT on code with no boolean literals (no false-fire by construction)", () => {
    const src = "export const add = (a: number, b: number): number => a + b;\n";
    expect(enumerateBooleanMutations(src).mutations).toEqual([]);
  });

  it("respects the candidate cap", () => {
    const src = "true true true true true";
    expect(enumerateBooleanMutations(src, 2).mutations).toHaveLength(2);
    expect(enumerateBooleanMutations(src, 2).truncated).toBe(true);
  });
});

// The archetype through the shared driver (proves it's a real, wired archetype).
const booleanArch = (): RepairArchetype => ({
  logName: "bool-repair",
  targets: (s) => (s.lockedTargetPath ? [s.lockedTargetPath] : []),
  candidatesFor: (_s, _p, current) =>
    enumerateBooleanMutations(current).mutations.map((m) => ({ candidate: m.candidate, label: m.label, line: m.line })),
});

describe("boolean archetype via runArchetypeRepair", () => {
  it("brute-forces the wrong-boolean-default flip and keeps the green one", async () => {
    const disk = new Map([["g.ts", "export const isAllowed = () => true;\n"]]);
    const read = async (p: string) => disk.get(p) ?? null;
    const write = async (p: string, c: string) => void disk.set(p, c);
    // The bug: should return false. Oracle greens only when the file says `false`.
    const oracle = async (): Promise<OracleVerdict> =>
      (disk.get("g.ts") ?? "").includes("=> false") ? ({ outcome: "solved" } as OracleVerdict) : ({ outcome: "failing", checks: [], feedback: "" } as OracleVerdict);
    const state = { repoRoot: "/r", lockedTargetPath: "g.ts", turns: [] } as unknown as AgentState;
    const baseline = { failingIds: new Set<string>(), hadAnyTests: true, redCount: 1, loadError: false };
    const r = await runArchetypeRepair(booleanArch(), state, baseline, read, write, oracle);
    expect(r?.label).toBe("boolean true->false");
    expect(disk.get("g.ts")).toContain("=> false"); // winner left on disk
  });
});
