import { describe, expect, it } from "bun:test";
import { advanceCarousel } from "../src/agent/carousel.ts";
import type { AgentState } from "../src/agent/types.ts";

// Minimal fake AgentState — advanceCarousel only reads/writes the carousel +
// stall/redraft fields, so the rest can be arbitrary placeholder values.
function fakeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    sessionId: "s1",
    task: "t",
    repoRoot: "/tmp/repo",
    modelId: "m",
    goals: [],
    currentGoalIndex: 0,
    turns: [],
    status: "running",
    scratchpad: "",
    startedAt: 0,
    updatedAt: 0,
    maxTurns: 10,
    ...overrides,
  };
}

// Threshold gating (stallCount >= STALL_LIMIT) now lives at the loop.ts call
// site, not inside the helper — these values are accepted for parity but the
// helper itself only enforces length>1 and the sweep cap. See carousel.ts.
const THRESHOLDS = { stallLimit: 2, maxRedrafts: 2 };

describe("advanceCarousel", () => {
  it("advances 0->1 and sets carouselFocus to editablePaths[1]", () => {
    const state = fakeState({ stallCount: 2 });
    advanceCarousel(state, ["a.ts", "b.ts"], THRESHOLDS);
    expect(state.carouselIndex).toBe(1);
    expect(state.carouselFocus).toBe("b.ts");
    expect(state.carouselCount).toBe(1);
  });

  it("wraps 1->0 (mod length) on a 2-file set", () => {
    const state = fakeState({ stallCount: 2, carouselIndex: 1, carouselCount: 1 });
    advanceCarousel(state, ["a.ts", "b.ts"], THRESHOLDS);
    expect(state.carouselIndex).toBe(0);
    expect(state.carouselFocus).toBe("a.ts");
    expect(state.carouselCount).toBe(2);
  });

  it("stops advancing after the 2-sweep cap (carouselCount)", () => {
    // 2-file set -> cap = 4. At carouselCount already 4, no further advance.
    const state = fakeState({ stallCount: 2, carouselIndex: 1, carouselCount: 4 });
    advanceCarousel(state, ["a.ts", "b.ts"], THRESHOLDS);
    expect(state.carouselIndex).toBe(1); // unchanged
    expect(state.carouselCount).toBe(4); // unchanged
  });

  it("resets stallCount/redraftCount/lastFailureSignature on advance", () => {
    const state = fakeState({
      stallCount: 2,
      redraftCount: 2,
      lastFailureSignature: "sig-xyz",
    });
    advanceCarousel(state, ["a.ts", "b.ts"], THRESHOLDS);
    expect(state.stallCount).toBe(0);
    expect(state.redraftCount).toBe(0);
    expect(state.lastFailureSignature).toBeUndefined();
  });

  it("never advances a single-file set (length 1)", () => {
    const state = fakeState({ stallCount: 5 });
    advanceCarousel(state, ["a.ts"], THRESHOLDS);
    expect(state.carouselIndex).toBeUndefined();
    expect(state.carouselFocus).toBeUndefined();
    expect(state.carouselCount).toBeUndefined();
  });
});
