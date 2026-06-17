import { test, expect } from "bun:test";
import { parseConfig } from "../src/config-schema";

test("fails when activeModel is missing", () => {
  const result = parseConfig({
    provider: { baseUrl: "http://localhost:11434", apiKey: "none" },
  });
  // activeModel is required — optional() above is the bug to fix
  expect(result.success).toBe(false);
});
