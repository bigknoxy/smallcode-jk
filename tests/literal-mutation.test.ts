import { describe, expect, it } from "bun:test";
import { enumerateLiteralMutations } from "../src/repair/literal-mutation.ts";
import { scopeMutationsToRange } from "../src/repair/operator-mutation.ts";

describe("enumerateLiteralMutations — finds standalone integer literals", () => {
  it("finds the 1 in toFixed(1) and generates a toFixed(2) candidate", () => {
    const { mutations } = enumerateLiteralMutations("return x.toFixed(1);");
    const plusOne = mutations.find((m) => m.base === 1 && m.delta === 1);
    expect(plusOne).toBeDefined();
    expect(plusOne!.candidate).toContain("toFixed(2)");
    expect(plusOne!.candidate).toBe("return x.toFixed(2);");
  });
});

describe("enumerateLiteralMutations — does not match identifiers/decimals", () => {
  it("skips property-adjacent digits and decimal literals", () => {
    const source = "const money2 = 1.5;";
    const { mutations } = enumerateLiteralMutations(source);
    for (const m of mutations) {
      expect(m.candidate).not.toContain("money3");
      expect(m.candidate).not.toContain("money1");
      expect(m.candidate).not.toContain("1.6");
      expect(m.candidate).not.toContain("2.5");
      expect(m.candidate).not.toContain("0.5");
    }
  });
});

describe("enumerateLiteralMutations — priority order", () => {
  it("ranks +1 before -1 before +2 for the same literal", () => {
    const { mutations } = enumerateLiteralMutations("toFixed(3)");
    const idxPlus1 = mutations.findIndex((m) => m.delta === 1);
    const idxMinus1 = mutations.findIndex((m) => m.delta === -1);
    const idxPlus2 = mutations.findIndex((m) => m.delta === 2);
    expect(idxPlus1).toBeGreaterThanOrEqual(0);
    expect(idxMinus1).toBeGreaterThanOrEqual(0);
    expect(idxPlus2).toBeGreaterThanOrEqual(0);
    expect(idxPlus1).toBeLessThan(idxMinus1);
    expect(idxMinus1).toBeLessThan(idxPlus2);
  });
});

describe("enumerateLiteralMutations — skips negative results", () => {
  it("value 0 yields only +1 and +2, no -1/-2", () => {
    const { mutations } = enumerateLiteralMutations("toFixed(0)");
    const deltas = mutations.map((m) => m.delta).sort();
    expect(deltas).toEqual([1, 2]);
  });
});

describe("enumerateLiteralMutations — cap / truncation", () => {
  it("caps at maxCandidates and reports truncated + totalFound", () => {
    const source = Array.from({ length: 30 }, (_, i) => `v${i} = ${i + 1}`).join(";");
    const result = enumerateLiteralMutations(source, 5);
    expect(result.mutations.length).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.totalFound).toBeGreaterThan(5);
  });
});

describe("enumerateLiteralMutations — line numbers", () => {
  it("reports the 1-based line the literal is on", () => {
    const source = "const a = 1;\nconst b = 2;\nreturn x.toFixed(1);\n";
    const { mutations } = enumerateLiteralMutations(source);
    const m = mutations.find((mm) => mm.candidate.includes("toFixed(2)"));
    expect(m).toBeDefined();
    expect(m!.line).toBe(3);
  });
});

describe("scopeMutationsToRange (reused from operator-mutation) — filters by line range", () => {
  it("keeps only literal mutations whose line falls in range", () => {
    const source = "const a = 1;\nconst b = 2;\nreturn x.toFixed(1);\n";
    const { mutations } = enumerateLiteralMutations(source);
    const scoped = scopeMutationsToRange(mutations, { startLine: 3, endLine: 3 });
    expect(scoped.length).toBeGreaterThan(0);
    for (const m of scoped) expect(m.line).toBe(3);

    const scopedOut = scopeMutationsToRange(mutations, { startLine: 1, endLine: 1 });
    for (const m of scopedOut) expect(m.line).toBe(1);
    expect(scopedOut.every((m) => m.line !== 3)).toBe(true);
  });

  it("returns all mutations unchanged when range is undefined", () => {
    const { mutations } = enumerateLiteralMutations("toFixed(1)");
    const scoped = scopeMutationsToRange(mutations, undefined);
    expect(scoped).toEqual(mutations);
  });
});

describe("enumerateLiteralMutations — determinism", () => {
  it("returns deeply-equal mutations across repeated calls", () => {
    const source = "return a.toFixed(1) + b.slice(0, 2);";
    const first = enumerateLiteralMutations(source);
    const second = enumerateLiteralMutations(source);
    expect(second.mutations).toEqual(first.mutations);
    expect(second.totalFound).toBe(first.totalFound);
    expect(second.truncated).toBe(first.truncated);
  });
});
