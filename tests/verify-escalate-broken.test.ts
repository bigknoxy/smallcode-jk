import { test, expect, describe } from "bun:test";
import { escalateBrokenClean, type OracleVerdict } from "../src/verify/oracle.ts";

const base = (over: Partial<OracleVerdict>): OracleVerdict => ({
  outcome: "clean",
  checks: [],
  feedback: "",
  ...over,
});

describe("escalateBrokenClean (oracle-free revert-on-broken)", () => {
  test("clean + confidence 'broken' → failing + regressed + BUILD ERROR + diagnostic", () => {
    const v = escalateBrokenClean(
      base({ confidence: { level: "broken", signals: ["parse error in src/a.ts: Expected '}'"] } }),
    );
    expect(v.outcome).toBe("failing");
    expect(v.regressed).toBe(true);
    expect(v.feedback).toContain("BUILD ERROR");
    expect(v.feedback).toContain("src/a.ts");
    expect(v.diagnostic?.errorType).toBe("SyntaxError"); // triggers the R4 BUILD ERROR prompt block
    expect(v.newFailures?.[0]).toContain("parse error");
  });

  test("clean + confidence 'parses' → unchanged (a working untested edit is kept)", () => {
    const v = escalateBrokenClean(base({ confidence: { level: "parses", signals: [] } }));
    expect(v.outcome).toBe("clean");
    expect(v.regressed).toBeUndefined();
  });

  test("clean with no confidence (feature off) → unchanged", () => {
    const v = escalateBrokenClean(base({}));
    expect(v.outcome).toBe("clean");
  });

  test("already-failing verdict → unchanged (idempotent / no double-handling)", () => {
    const v = escalateBrokenClean(base({ outcome: "failing", feedback: "Tests failing" }));
    expect(v.outcome).toBe("failing");
    expect(v.feedback).toBe("Tests failing");
  });

  test("solved → never touched", () => {
    expect(escalateBrokenClean(base({ outcome: "solved" })).outcome).toBe("solved");
  });
});
