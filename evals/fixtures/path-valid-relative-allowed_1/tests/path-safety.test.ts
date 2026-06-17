import { test, expect } from "bun:test";
import { resolveSafe } from "../src/path-safety";

test("allows valid relative path inside root", () => {
  const result = resolveSafe("/workspace", "src/foo.ts");
  expect(result).toBe("/workspace/src/foo.ts");
});
