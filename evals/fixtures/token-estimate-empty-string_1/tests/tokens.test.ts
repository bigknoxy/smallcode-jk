import { test, expect } from "bun:test";
import { estimateTokens } from "../src/tokens";

test("empty string returns minimum 1", () => {
  expect(estimateTokens("")).toBe(1);
});
