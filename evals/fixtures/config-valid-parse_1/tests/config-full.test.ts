import { test, expect } from "bun:test";
import { parseFullConfig } from "../src/config-full";

test("valid config parses successfully", () => {
  const result = parseFullConfig({
    provider: { baseUrl: "http://localhost:11434", apiKey: "none" },
    activeModel: "vibethinker-3b",
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.activeModel).toBe("vibethinker-3b");
    expect(result.data.maxTurns).toBe(15);
  }
});
