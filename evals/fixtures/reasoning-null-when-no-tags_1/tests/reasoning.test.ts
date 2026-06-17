import { test, expect } from "bun:test";
import { parseReasoning } from "../src/reasoning";

test("returns null reasoning when no think tags", () => {
  const result = parseReasoning("Just a plain answer.");
  expect(result.reasoning).toBeNull();
  expect(result.answer).toBe("Just a plain answer.");
});
