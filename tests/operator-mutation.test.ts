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
    // Extended module now also emits a logical (&&->||) candidate for this
    // source, so filter to the eq-invert candidates this test targets.
    const eqMutations = mutations.filter((m) => m.kind === "eq-invert");
    expect(eqMutations.length).toBe(2);
    for (const m of eqMutations) {
      const count = (m.candidate.match(/!==/g) ?? []).length;
      expect(count).toBe(1);
      const eqCount = (m.candidate.match(/(?<!!)===/g) ?? []).length;
      expect(eqCount).toBe(1);
    }
  });
});

describe("enumerateComparisonMutations — logical flips", () => {
  it("flips && to ||", () => {
    const { mutations } = enumerateComparisonMutations("return a && b");
    expect(mutations.length).toBe(1);
    const m = mutations[0]!;
    expect(m.kind).toBe("logical");
    expect(m.candidate).toBe("return a || b");
  });

  it("flips || to &&", () => {
    const { mutations } = enumerateComparisonMutations("a || b");
    expect(mutations.length).toBe(1);
    const m = mutations[0]!;
    expect(m.kind).toBe("logical");
    expect(m.candidate).toBe("a && b");
  });
});

describe("enumerateComparisonMutations — arithmetic flips", () => {
  it("flips + to -", () => {
    const { mutations } = enumerateComparisonMutations("x + y");
    expect(mutations.length).toBe(1);
    const m = mutations[0]!;
    expect(m.kind).toBe("arith");
    expect(m.candidate).toBe("x - y");
  });

  it("flips - to +", () => {
    const { mutations } = enumerateComparisonMutations("x - y");
    expect(mutations.length).toBe(1);
    const m = mutations[0]!;
    expect(m.kind).toBe("arith");
    expect(m.candidate).toBe("x + y");
  });
});

describe("enumerateComparisonMutations — compound/increment SKIP tokens", () => {
  it("skips ++, --, +=, -= and produces zero mutations when no bare +/- remain", () => {
    const result = enumerateComparisonMutations("i++; j += 1; k--; m -= 2;");
    expect(result.mutations.length).toBe(0);
    expect(result.totalFound).toBe(0);
  });

  it("skips i++ individually", () => {
    const result = enumerateComparisonMutations("i++");
    expect(result.mutations.length).toBe(0);
  });

  it("skips k-- individually", () => {
    const result = enumerateComparisonMutations("k--");
    expect(result.mutations.length).toBe(0);
  });

  it("skips a += b individually", () => {
    const result = enumerateComparisonMutations("a += b");
    expect(result.mutations.length).toBe(0);
  });

  it("skips a -= b individually", () => {
    const result = enumerateComparisonMutations("a -= b");
    expect(result.mutations.length).toBe(0);
  });

  it("skips j+=1 with no spacing", () => {
    const result = enumerateComparisonMutations("j+=1");
    expect(result.mutations.length).toBe(0);
  });
});

describe("enumerateComparisonMutations — bitwise not matched", () => {
  it("produces zero mutations for bare bitwise | and &", () => {
    expect(enumerateComparisonMutations("a | b").mutations.length).toBe(0);
    expect(enumerateComparisonMutations("a & b").mutations.length).toBe(0);
  });

  it("still matches doubled logical || and &&", () => {
    expect(enumerateComparisonMutations("a || b").mutations.length).toBe(1);
    expect(enumerateComparisonMutations("a && b").mutations.length).toBe(1);
  });
});

describe("enumerateComparisonMutations — priority across all classes", () => {
  it("orders eq-invert, then logical, then arith for a === b && c + d", () => {
    const { mutations } = enumerateComparisonMutations("a === b && c + d");
    expect(mutations.map((m) => m.kind)).toEqual(["eq-invert", "logical", "arith"]);
  });

  it("orders boundary/relational before logical and arith for i < n && i + 1", () => {
    const { mutations } = enumerateComparisonMutations("i < n && i + 1");
    const kinds = mutations.map((m) => m.kind);
    const logicalIdx = kinds.indexOf("logical");
    const arithIdx = kinds.indexOf("arith");
    const boundaryIdx = kinds.indexOf("boundary");
    const relIdx = kinds.indexOf("rel-invert");
    expect(boundaryIdx).toBeGreaterThanOrEqual(0);
    expect(relIdx).toBeGreaterThanOrEqual(0);
    expect(logicalIdx).toBeGreaterThan(boundaryIdx);
    expect(logicalIdx).toBeGreaterThan(relIdx);
    expect(arithIdx).toBeGreaterThan(logicalIdx);
  });
});

describe("enumerateComparisonMutations — arith single-occurrence isolation", () => {
  it("flips exactly one of two + occurrences per candidate", () => {
    const { mutations } = enumerateComparisonMutations("a + b + c");
    expect(mutations.length).toBe(2);
    for (const m of mutations) {
      const minusCount = (m.candidate.match(/-/g) ?? []).length;
      const plusCount = (m.candidate.match(/\+/g) ?? []).length;
      expect(minusCount).toBe(1);
      expect(plusCount).toBe(1);
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
