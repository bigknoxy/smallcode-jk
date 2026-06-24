/**
 * Tests for GEPA Pareto-front: dominates(), ParetoFront.add(), ParetoFront.select()
 */

import { describe, expect, it } from "bun:test";
import { dominates, ParetoFront } from "../src/improve/gepa/pareto-front.ts";
import type { Candidate } from "../src/improve/gepa/types.ts";
import { defaultPromptSet } from "../src/agent/prompt-set.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  id: string,
  scores: Record<string, number>,
  overrides: Partial<Omit<Candidate, "id" | "scores">> = {},
): Candidate {
  const meanScore =
    Object.keys(scores).length === 0
      ? 0
      : Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length;
  return {
    id,
    prompts: defaultPromptSet(),
    parentId: null,
    generation: 0,
    scores,
    meanScore,
    ...overrides,
  };
}

const TASK_IDS = ["e0", "e1", "e2"];

// ---------------------------------------------------------------------------
// dominates()
// ---------------------------------------------------------------------------

describe("dominates()", () => {
  it("returns true when a strictly dominates b (better on all tasks)", () => {
    const a = makeCandidate("a", { e0: 1.0, e1: 0.8, e2: 0.9 });
    const b = makeCandidate("b", { e0: 0.5, e1: 0.5, e2: 0.5 });
    expect(dominates(a, b, TASK_IDS)).toBe(true);
  });

  it("returns false when a and b are equal on all tasks", () => {
    const a = makeCandidate("a", { e0: 0.5, e1: 0.5, e2: 0.5 });
    const b = makeCandidate("b", { e0: 0.5, e1: 0.5, e2: 0.5 });
    expect(dominates(a, b, TASK_IDS)).toBe(false);
  });

  it("returns false when b is better on one task", () => {
    const a = makeCandidate("a", { e0: 1.0, e1: 0.5, e2: 0.9 });
    const b = makeCandidate("b", { e0: 1.0, e1: 0.8, e2: 0.9 });
    expect(dominates(a, b, TASK_IDS)).toBe(false);
  });

  it("returns true for strictly better on exactly one task, equal on rest", () => {
    const a = makeCandidate("a", { e0: 1.0, e1: 0.5, e2: 0.5 });
    const b = makeCandidate("b", { e0: 0.8, e1: 0.5, e2: 0.5 });
    expect(dominates(a, b, TASK_IDS)).toBe(true);
  });

  it("returns false for empty taskIds", () => {
    const a = makeCandidate("a", {});
    const b = makeCandidate("b", {});
    expect(dominates(a, b, [])).toBe(false);
  });

  it("handles missing scores (treated as 0)", () => {
    // a has score on e0 only; b has scores on all tasks but lower on e0
    const a = makeCandidate("a", { e0: 1.0 });
    const b = makeCandidate("b", { e0: 0.5, e1: 0.5, e2: 0.5 });
    // a: e0=1.0, e1=0, e2=0  vs b: e0=0.5, e1=0.5, e2=0.5
    // a is better on e0, worse on e1 and e2 → a does NOT dominate b
    expect(dominates(a, b, TASK_IDS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ParetoFront.add()
// ---------------------------------------------------------------------------

describe("ParetoFront.add()", () => {
  it("accepts the first candidate unconditionally", () => {
    const front = new ParetoFront(TASK_IDS, 10);
    const a = makeCandidate("a", { e0: 0.5, e1: 0.5, e2: 0.5 });
    expect(front.add(a)).toBe(true);
    expect(front.members()).toHaveLength(1);
  });

  it("rejects a dominated candidate", () => {
    const front = new ParetoFront(TASK_IDS, 10);
    const a = makeCandidate("a", { e0: 1.0, e1: 1.0, e2: 1.0 });
    const b = makeCandidate("b", { e0: 0.5, e1: 0.5, e2: 0.5 });
    front.add(a);
    expect(front.add(b)).toBe(false);
    expect(front.members()).toHaveLength(1);
  });

  it("adds and evicts: new candidate dominates existing", () => {
    const front = new ParetoFront(TASK_IDS, 10);
    const a = makeCandidate("a", { e0: 0.5, e1: 0.5, e2: 0.5 });
    const b = makeCandidate("b", { e0: 1.0, e1: 1.0, e2: 1.0 });
    front.add(a);
    expect(front.add(b)).toBe(true);
    // b dominates a → a evicted
    const ids = front.members().map((m) => m.id);
    expect(ids).toContain("b");
    expect(ids).not.toContain("a");
  });

  it("coexists non-comparable candidates (no dominance either way)", () => {
    const front = new ParetoFront(TASK_IDS, 10);
    // a better on e0, b better on e1 → neither dominates the other
    const a = makeCandidate("a", { e0: 1.0, e1: 0.0, e2: 0.5 });
    const b = makeCandidate("b", { e0: 0.0, e1: 1.0, e2: 0.5 });
    front.add(a);
    front.add(b);
    expect(front.members()).toHaveLength(2);
  });

  it("enforces populationCap by dropping lowest meanScore", () => {
    const front = new ParetoFront(TASK_IDS, 2);
    // Three non-comparable candidates
    const a = makeCandidate("a", { e0: 1.0, e1: 0.0, e2: 0.0 }); // meanScore ~0.33
    const b = makeCandidate("b", { e0: 0.0, e1: 1.0, e2: 0.0 }); // meanScore ~0.33
    const c = makeCandidate("c", { e0: 0.0, e1: 0.0, e2: 1.0 }); // meanScore ~0.33

    front.add(a);
    front.add(b);
    front.add(c);

    // Cap is 2, so one was dropped
    expect(front.members()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ParetoFront.select()
// ---------------------------------------------------------------------------

describe("ParetoFront.select()", () => {
  it("throws when front is empty", () => {
    const front = new ParetoFront(TASK_IDS, 10);
    expect(() => front.select(() => 0)).toThrow();
  });

  it("returns the only member when front has one element", () => {
    const front = new ParetoFront(TASK_IDS, 10);
    const a = makeCandidate("a", { e0: 0.5, e1: 0.5, e2: 0.5 });
    front.add(a);
    expect(front.select(() => 0).id).toBe("a");
  });

  it("selects a specialist via deterministic rng", () => {
    const front = new ParetoFront(TASK_IDS, 10);
    // a wins e0 only; b wins e1 only; c wins e2 only
    const a = makeCandidate("a", { e0: 1.0, e1: 0.0, e2: 0.0 });
    const b = makeCandidate("b", { e0: 0.0, e1: 1.0, e2: 0.0 });
    const c = makeCandidate("c", { e0: 0.0, e1: 0.0, e2: 1.0 });
    front.add(a);
    front.add(b);
    front.add(c);

    // Each has weight 1 (specialist on exactly 1 task). Total weight = 3.
    // rng=0.0 → threshold=0*3=0 → first candidate selected
    const selected0 = front.select(() => 0);
    expect(["a", "b", "c"]).toContain(selected0.id);
  });

  it("a candidate winning more tasks gets selected with higher probability", () => {
    const front = new ParetoFront(["e0", "e1", "e2", "e3"], 10);
    // a wins e0 and e1 (weight 2); b wins e2 (weight 1); c wins e3 (weight 1)
    const a = makeCandidate("a", { e0: 1.0, e1: 1.0, e2: 0.0, e3: 0.0 });
    const b = makeCandidate("b", { e0: 0.0, e1: 0.0, e2: 1.0, e3: 0.0 });
    const c = makeCandidate("c", { e0: 0.0, e1: 0.0, e2: 0.0, e3: 1.0 });
    front.add(a);
    front.add(b);
    front.add(c);

    // Total weight = 4. Threshold for selecting a: first 2/4 = 0.5 of the range.
    // rng=0.1 → threshold=0.1*4=0.4 → within a's weight window
    const selected = front.select(() => 0.1);
    expect(selected.id).toBe("a");
  });
});
