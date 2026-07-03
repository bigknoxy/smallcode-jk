import { describe, expect, it } from "bun:test";
import { enumerateComparisonMutations } from "../src/repair/operator-mutation.ts";

describe("enumerateComparisonMutations — equality inversion", () => {
  it("flips === to !== ", () => {
    const { mutations } = enumerateComparisonMutations("if (a === b) {}");
    expect(mutations.length).toBe(1);
    const m = mutations[0]!;
    expect(m.candidate).toBe("if (a !== b) {}");
    expect(m.kind).toBe("eq-invert");
    expect(m.line).toBe(1);
    expect(m.label).toBe("=== -> !==");
    expect(m.original).toBe("===");
    expect(m.mutated).toBe("!==");
  });

  it("flips !== to ===", () => {
    const { mutations } = enumerateComparisonMutations("x !== 45");
    expect(mutations.length).toBe(1);
    expect(mutations[0]!.candidate).toBe("x === 45");
    expect(mutations[0]!.kind).toBe("eq-invert");
  });
});

describe("enumerateComparisonMutations — boundary + relational for <", () => {
  it("produces boundary (<=) before relational (>=, >) candidates", () => {
    const { mutations } = enumerateComparisonMutations("i < n");
    const labels = mutations.map((m) => m.label);
    expect(labels).toContain("< -> <=");
    expect(labels).toContain("< -> >=");
    expect(labels).toContain("< -> >");

    const boundaryIdx = labels.indexOf("< -> <=");
    const relGeIdx = labels.indexOf("< -> >=");
    const relGtIdx = labels.indexOf("< -> >");
    expect(boundaryIdx).toBeLessThan(relGeIdx);
    expect(boundaryIdx).toBeLessThan(relGtIdx);

    const boundary = mutations[boundaryIdx]!;
    expect(boundary.kind).toBe("boundary");
    const relGe = mutations[relGeIdx]!;
    const relGt = mutations[relGtIdx]!;
    expect(relGe.kind).toBe("rel-invert");
    expect(relGt.kind).toBe("rel-invert");
  });
});

describe("enumerateComparisonMutations — skip tokens", () => {
  it("skips =>, <<, >> and never matches the bare = of an arrow assignment", () => {
    const result = enumerateComparisonMutations("const f = () => a << 2 >> 1");
    expect(result.mutations.length).toBe(0);
    expect(result.totalFound).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

describe("enumerateComparisonMutations — priority ordering across kinds", () => {
  it("orders equality-inversion candidates before relational/boundary candidates", () => {
    const { mutations } = enumerateComparisonMutations("a === b && c < d");
    const eqIdx = mutations.findIndex((m) => m.kind === "eq-invert");
    const firstRelOrBoundaryIdx = mutations.findIndex(
      (m) => m.kind === "boundary" || m.kind === "rel-invert",
    );
    expect(eqIdx).toBeGreaterThanOrEqual(0);
    expect(firstRelOrBoundaryIdx).toBeGreaterThanOrEqual(0);
    expect(eqIdx).toBeLessThan(firstRelOrBoundaryIdx);
  });
});

describe("enumerateComparisonMutations — cap / truncation", () => {
  it("caps at maxCandidates and reports truncated + totalFound", () => {
    const source = Array.from({ length: 50 }, (_, i) => `a${i}===b${i}`).join(";");
    const result = enumerateComparisonMutations(source, 5);
    expect(result.mutations.length).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.totalFound).toBe(50);
  });
});

describe("enumerateComparisonMutations — line numbers", () => {
  it("reports the 1-based line the operator is on", () => {
    const source = "const a = 1;\nconst b = 2;\nif (a === b) {}\n";
    const { mutations } = enumerateComparisonMutations(source);
    expect(mutations.length).toBe(1);
    expect(mutations[0]!.line).toBe(3);
  });
});

describe("enumerateComparisonMutations — single-occurrence isolation", () => {
  it("flips exactly one of two identical operators per candidate", () => {
    const source = "if (a === b && c === d) {}";
    const { mutations } = enumerateComparisonMutations(source);
    expect(mutations.length).toBe(2);
    for (const m of mutations) {
      const count = (m.candidate.match(/!==/g) ?? []).length;
      expect(count).toBe(1);
      const eqCount = (m.candidate.match(/(?<!!)===/g) ?? []).length;
      expect(eqCount).toBe(1);
    }
  });
});

describe("enumerateComparisonMutations — determinism", () => {
  it("returns deeply-equal mutations across repeated calls", () => {
    const source = "if (a === b) { return c < d ? c >= e : f !== g; }";
    const first = enumerateComparisonMutations(source);
    const second = enumerateComparisonMutations(source);
    expect(second.mutations).toEqual(first.mutations);
    expect(second.totalFound).toBe(first.totalFound);
    expect(second.truncated).toBe(first.truncated);
  });
});
