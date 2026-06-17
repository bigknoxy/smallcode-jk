import { test, expect } from "bun:test";
import { ModelRegistry } from "../src/registry";

test("custom profile can be registered and retrieved", () => {
  const registry = new ModelRegistry();
  registry.register({ id: "my-custom-7b", temperature: 0.8, maxTokens: 8192 });
  const profile = registry.get("my-custom-7b");
  expect(profile.id).toBe("my-custom-7b");
  expect(profile.temperature).toBe(0.8);
});
