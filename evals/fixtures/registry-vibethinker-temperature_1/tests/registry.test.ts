import { test, expect } from "bun:test";
import { ModelRegistry } from "../src/registry";

test("vibethinker-3b has temperature 1.0", () => {
  const registry = new ModelRegistry();
  const profile = registry.get("vibethinker-3b");
  expect(profile.temperature).toBe(1.0);
});
