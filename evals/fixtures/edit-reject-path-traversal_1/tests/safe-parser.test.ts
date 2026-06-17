import { test, expect } from "bun:test";
import { isSafePath } from "../src/safe-parser";

test("rejects path traversal", () => {
  expect(isSafePath("../../../etc/passwd")).toBe(false);
});

test("rejects absolute path", () => {
  expect(isSafePath("/etc/passwd")).toBe(false);
});

test("allows normal relative path", () => {
  expect(isSafePath("src/foo.ts")).toBe(true);
});
