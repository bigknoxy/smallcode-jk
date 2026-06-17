import { test, expect } from "bun:test";
import { resolveSafe } from "../src/path-safety";

test("rejects path traversal", () => {
  expect(() => resolveSafe("/workspace", "../../../etc/passwd")).toThrow();
});
