import { test, expect } from "bun:test";
import { parseReasoning } from "../src/reasoning";

test("strips <think> tags and returns clean answer", () => {
  const raw = "<think>let me think</think>The answer is 42.";
  const result = parseReasoning(raw);
  expect(result.answer).toBe("The answer is 42.");
  expect(result.reasoning).toBe("let me think");
});
