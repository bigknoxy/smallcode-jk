import { test, expect } from "bun:test";
import { resolveSafe } from "../src/path-safety";

test("rejects absolute path escaping root", () => {
  expect(() => resolveSafe("/workspace", "/etc/passwd")).toThrow();
});
