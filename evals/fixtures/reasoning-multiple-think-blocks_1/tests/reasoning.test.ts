import { test, expect } from "bun:test";
import { parseReasoning } from "../src/reasoning";

test("handles multiple think blocks", () => {
  const raw = "<think>step one</think>partial<think>step two</think>Final answer.";
  const result = parseReasoning(raw);
  expect(result.answer.trim()).toBe("Final answer.");
  expect(result.reasoning).toContain("step one");
  expect(result.reasoning).toContain("step two");
});
