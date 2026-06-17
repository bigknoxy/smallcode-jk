import { test, expect } from "bun:test";
import { estimateTokens } from "../src/tokens";

test("40-char string estimates to ~10 tokens", () => {
  // 'The quick brown fox jumps over the lazy' = 38 chars, ~9-10 tokens
  const result = estimateTokens("The quick brown fox jumps over the lazy");
  expect(result).toBeGreaterThanOrEqual(8);
  expect(result).toBeLessThanOrEqual(12);
});

test("empty string returns minimum 1", () => {
  expect(estimateTokens("")).toBeGreaterThanOrEqual(1);
});
