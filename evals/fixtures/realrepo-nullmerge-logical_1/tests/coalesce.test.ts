import { test, expect, describe } from "bun:test";
import coalesce from "../src/index.js";

describe("coalesce", () => {
  test("returns the non-null second arg when first is null", () => {
    // Bug: connective inverted — `||` instead of `&&` — so a single null
    // arg wrongly short-circuits to null instead of falling through to
    // the non-null value.
    // Clean: coalesce(null, 5) => 5
    // Buggy:  coalesce(null, 5) => null
    expect(coalesce(null, 5)).toBe(5);
  });

  test("returns the non-null first arg when second is null", () => {
    expect(coalesce(1, null)).toBe(1);
  });

  test("returns null only when both args are null", () => {
    expect(coalesce(null, null)).toBe(null);
  });

  test("returns the first arg when neither is null", () => {
    expect(coalesce(2, 3)).toBe(2);
  });
});
