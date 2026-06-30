import { test, expect } from "bun:test";
import { emails } from "../src/pluck.ts";
test("only profiled users", () => {
  const out = emails([
    { name: "a", profile: { email: "a@x.com" } },
    { name: "b" },
    { name: "c", profile: { email: "c@x.com" } },
  ]);
  expect(out).toEqual(["a@x.com", "c@x.com"]);
});
