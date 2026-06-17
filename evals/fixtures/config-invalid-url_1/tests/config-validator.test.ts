import { test, expect } from "bun:test";
import { validateProviderConfig } from "../src/config-validator";

test("rejects invalid URL", () => {
  const result = validateProviderConfig({ baseUrl: "not-a-url", apiKey: "k" });
  expect(result.success).toBe(false);
});

test("accepts valid URL", () => {
  const result = validateProviderConfig({ baseUrl: "http://localhost:11434", apiKey: "k" });
  expect(result.success).toBe(true);
});
