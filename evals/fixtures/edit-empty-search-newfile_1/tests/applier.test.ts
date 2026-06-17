import { test, expect } from "bun:test";
import { applyEdit } from "../src/applier";

test("empty search creates new file", () => {
  const files = new Map<string, string>();
  const result = applyEdit(files, "src/new.ts", "", "export const x = 1;\n");
  expect(result.get("src/new.ts")).toBe("export const x = 1;\n");
});
