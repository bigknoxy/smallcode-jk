import { test, expect, describe } from "bun:test";
import wrapIndex from "../src/index.js";

describe("wrapIndex", () => {
  test("negative index wraps to a positive slot", () => {
    // Bug: safe-modulo sign flipped — `- len` instead of `+ len` — so
    // negative inputs stay negative instead of wrapping into [0, len).
    // Clean: wrapIndex(-1, 3) => 2
    // Buggy:  wrapIndex(-1, 3) => -1
    expect(wrapIndex(-1, 3)).toBe(2);
  });

  test("more negative index still wraps correctly", () => {
    expect(wrapIndex(-4, 3)).toBe(2);
  });

  test("index beyond len wraps forward", () => {
    expect(wrapIndex(4, 3)).toBe(1);
  });

  test("zero stays zero", () => {
    expect(wrapIndex(0, 3)).toBe(0);
  });

  test("index equal to len wraps to zero", () => {
    expect(wrapIndex(3, 3)).toBe(0);
  });
});
