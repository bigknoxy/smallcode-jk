import { test, expect, describe } from "bun:test";
import { extractSourceFrame, extractFirstFailure } from "../src/verify/failure-extract.ts";

// Real bun v1.3.x trace shapes captured from the R2 forensic probe.
const ASSERTION_MISMATCH = `
calc.test.ts:
2 | test("adds", () => { expect(add(2, 3)).toBe(5); });
                                          ^
error: expect(received).toBe(expected)

Expected: 5
Received: -1

      at <anonymous> (/repo/calc.test.ts:3:40)
(fail) adds [0.25ms]
 0 pass
 2 fail
`;

const RUNTIME_THROW = `
error: neg
      at risky (/repo/src/calc.ts:5:35)
      at <anonymous> (/repo/calc.test.ts:4:36)
(fail) throws path [0.01ms]
 0 pass
 1 fail
`;

const THROW_VIA_NODE_MODULES = `
error: boom
      at deep (/repo/node_modules/dep/index.js:9:2)
      at run (/repo/src/app.ts:12:7)
      at <anonymous> (/repo/app.test.ts:3:1)
(fail) explodes [0.02ms]
 0 pass
 1 fail
`;

describe("R2 extractSourceFrame", () => {
  test("returns the source frame for a runtime throw", () => {
    expect(extractSourceFrame(RUNTIME_THROW)).toEqual({ file: "/repo/src/calc.ts", line: 5 });
  });

  test("returns null for an assertion mismatch (trace stops at the test file)", () => {
    expect(extractSourceFrame(ASSERTION_MISMATCH)).toBeNull();
  });

  test("skips node_modules frames, picks first real source frame", () => {
    expect(extractSourceFrame(THROW_VIA_NODE_MODULES)).toEqual({ file: "/repo/src/app.ts", line: 12 });
  });
});

describe("R2 diagnostic location wiring", () => {
  test("throw failure carries sourceFile/sourceLine", () => {
    const d = extractFirstFailure(RUNTIME_THROW);
    expect(d?.sourceFile).toBe("/repo/src/calc.ts");
    expect(d?.sourceLine).toBe(5);
  });

  test("value-mismatch failure does NOT carry a location (would point at the test line)", () => {
    const d = extractFirstFailure(ASSERTION_MISMATCH);
    expect(d?.expected).toBe("5");
    expect(d?.actual).toBe("-1");
    expect(d?.sourceFile).toBeUndefined();
    expect(d?.sourceLine).toBeUndefined();
  });
});
