import { test, expect } from "bun:test";
import { ModelRegistry } from "../src/registry";

test("throws descriptive error for unknown model", () => {
  const registry = new ModelRegistry();
  expect(() => registry.get("nonexistent-model")).toThrow("nonexistent-model");
});
