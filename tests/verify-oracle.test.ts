import { test, expect, describe } from "bun:test";
import { classifyTest, parseFailingTestIds, tscHasRealErrors } from "../src/verify/oracle.ts";

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

describe("parseFailingTestIds", () => {
  test("single failing test: (fail) marker", () => {
    const output = "(fail) failing test [0.10ms]";
    const ids = parseFailingTestIds(output);
    expect(ids.size).toBe(1);
    expect(ids.has("failing test")).toBe(true);
  });

  test("multiple failing tests", () => {
    const output = [
      "(fail) my suite > inner failing [0.11ms]",
      "(fail) top-level fail [0.08ms]",
    ].join("\n");
    const ids = parseFailingTestIds(output);
    expect(ids.size).toBe(2);
    expect(ids.has("my suite > inner failing")).toBe(true);
    expect(ids.has("top-level fail")).toBe(true);
  });

  test("green output (no fails) → empty set", () => {
    const output = " 1 pass\n 0 fail\n Ran 1 test across 1 file. [4.00ms]";
    const ids = parseFailingTestIds(output);
    expect(ids.size).toBe(0);
  });

  test("✗ marker variant", () => {
    const output = "✗ some test name [5ms]";
    const ids = parseFailingTestIds(output);
    expect(ids.size).toBe(1);
    expect(ids.has("some test name")).toBe(true);
  });

  test("timing suffix stripped — same test label each run", () => {
    const output1 = "(fail) add works [0.10ms]";
    const output2 = "(fail) add works [12.33ms]";
    const ids1 = parseFailingTestIds(output1);
    const ids2 = parseFailingTestIds(output2);
    expect([...ids1][0]).toBe([...ids2][0]);
    expect(ids1.has("add works")).toBe(true);
  });

  test("pass lines are not parsed as failures", () => {
    const output = " 2 pass\n 1 fail\n(fail) broken thing [1ms]";
    const ids = parseFailingTestIds(output);
    expect(ids.size).toBe(1);
    expect(ids.has("broken thing")).toBe(true);
  });
});

describe("baseline diff logic", () => {
  test("current ⊇ baseline by one new id → that id is sole newFailure", () => {
    const baselineIds = new Set(["pre-existing fail"]);
    const currentIds = new Set(["pre-existing fail", "new fail"]);
    const newFailures = [...currentIds].filter((id) => !baselineIds.has(id));
    expect(newFailures).toEqual(["new fail"]);
  });

  test("current === baseline → no new failures", () => {
    const baselineIds = new Set(["pre-existing fail"]);
    const currentIds = new Set(["pre-existing fail"]);
    const newFailures = [...currentIds].filter((id) => !baselineIds.has(id));
    expect(newFailures).toHaveLength(0);
  });

  test("baseline empty, current has fail → all are new", () => {
    const baselineIds = new Set<string>();
    const currentIds = new Set(["brand new fail"]);
    const newFailures = [...currentIds].filter((id) => !baselineIds.has(id));
    expect(newFailures).toEqual(["brand new fail"]);
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
