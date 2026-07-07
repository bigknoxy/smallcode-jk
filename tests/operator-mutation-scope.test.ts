import { describe, expect, test } from "bun:test";
import { enumerateComparisonMutations, scopeMutationsToRange } from "@/repair/operator-mutation.ts";

describe("scopeMutationsToRange", () => {
  test("keeps only items whose line falls inside the range", () => {
    const items = [{ line: 3 }, { line: 7 }, { line: 12 }, { line: 40 }];
    const result = scopeMutationsToRange(items, { startLine: 5, endLine: 15 });
    expect(result.map((r) => r.line)).toEqual([7, 12]);
  });

  test("range undefined returns the array unchanged", () => {
    const items = [{ line: 3 }, { line: 7 }, { line: 12 }, { line: 40 }];
    const result = scopeMutationsToRange(items, undefined);
    expect(result).toHaveLength(items.length);
    expect(result).toEqual(items);
  });

  test("range that excludes everything returns []", () => {
    const items = [{ line: 3 }, { line: 7 }, { line: 12 }, { line: 40 }];
    const result = scopeMutationsToRange(items, { startLine: 100, endLine: 200 });
    expect(result).toEqual([]);
  });

  test("boundary inclusivity: startLine and endLine are both kept", () => {
    const items = [{ line: 5 }, { line: 6 }, { line: 15 }, { line: 16 }];
    const result = scopeMutationsToRange(items, { startLine: 5, endLine: 15 });
    expect(result.map((r) => r.line)).toEqual([5, 6, 15]);
  });

  test("integration: drops an out-of-range operator flip found by the enumerator", () => {
    const source = ["function inRange(a, b) {", "  return a === b;", "}", "", "function outOfRange(a, b) {", "  return a < b;", "}"].join(
      "\n",
    );
    const { mutations } = enumerateComparisonMutations(source);
    // Sanity: both operators were found before scoping.
    expect(mutations.some((m) => m.line === 2)).toBe(true);
    expect(mutations.some((m) => m.line === 6)).toBe(true);

    const scoped = scopeMutationsToRange(mutations, { startLine: 1, endLine: 3 });
    expect(scoped.every((m) => m.line >= 1 && m.line <= 3)).toBe(true);
    expect(scoped.some((m) => m.line === 6)).toBe(false);
  });
});
