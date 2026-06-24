import { test, expect, describe } from "bun:test";
import { classifyTest, tscHasRealErrors } from "../src/verify/oracle.ts";

describe("classifyTest", () => {
  test("green: passes, zero fails, exit 0", () => {
    expect(classifyTest("1 pass\n0 fail\nRan 1 test", 0)).toBe("green");
  });
  test("red: any fail count", () => {
    expect(classifyTest("2 pass\n1 fail\nRan 3 tests", 1)).toBe("red");
  });
  test("red beats green even on exit 0 oddity", () => {
    expect(classifyTest("5 pass\n2 fail", 0)).toBe("red");
  });
  test("absent: no pass, no fail (bun found no test files)", () => {
    expect(classifyTest("error: no test files found", 1)).toBe("absent");
  });
  test("absent: zero pass zero fail", () => {
    expect(classifyTest("0 pass\n0 fail", 1)).toBe("absent");
  });
  test("not-green when pass>0 but exit nonzero", () => {
    // pass but nonzero exit and no fails → treat as absent (not a confident green)
    expect(classifyTest("1 pass", 1)).toBe("absent");
  });
});

describe("tscHasRealErrors", () => {
  test("real type error (TS2322) counts", () => {
    expect(tscHasRealErrors("src/x.ts(3,5): error TS2322: Type 'string' is not assignable")).toBe(
      true,
    );
  });
  test("config error (TS5058 cannot find tsconfig) does NOT count", () => {
    expect(tscHasRealErrors("error TS5058: The specified path does not exist")).toBe(false);
  });
  test("config error TS6053 does NOT count", () => {
    expect(tscHasRealErrors("error TS6053: File not found")).toBe(false);
  });
  test("no diagnostics at all → false", () => {
    expect(tscHasRealErrors("")).toBe(false);
    expect(tscHasRealErrors("everything fine")).toBe(false);
  });
  test("mix of config + real → true (real present)", () => {
    expect(
      tscHasRealErrors("error TS5058: bad path\nsrc/a.ts(1,1): error TS2304: Cannot find name 'x'"),
    ).toBe(true);
  });
});
