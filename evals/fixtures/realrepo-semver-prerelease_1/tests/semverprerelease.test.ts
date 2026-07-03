import { test, expect, describe } from "bun:test";
import compare from "../src/index.js";

describe("compare", () => {
  test("prerelease has lower precedence than release", () => {
    expect(compare("1.0.0-alpha", "1.0.0")).toBe(-1);
  });

  test("release has higher precedence than prerelease", () => {
    expect(compare("1.0.0", "1.0.0-alpha")).toBe(1);
  });

  test("equal versions compare equal", () => {
    expect(compare("1.0.0", "1.0.0")).toBe(0);
  });

  test("major version differences dominate", () => {
    expect(compare("2.0.0", "1.9.9")).toBe(1);
  });

  test("prerelease identifiers compare lexically", () => {
    expect(compare("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  });

  test("numeric prerelease identifiers compare numerically", () => {
    expect(compare("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(-1);
  });
});
