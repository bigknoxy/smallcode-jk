import { describe, expect, it } from "bun:test";
import {
  extractFirstFailure,
  failureSignature,
  renderDiagnostic,
} from "../src/verify/failure-extract.ts";

// ---------------------------------------------------------------------------
// Additional fixtures (captured from real bun v1.3.x runs in temp repos)
// ---------------------------------------------------------------------------

// toEqual — emits a unified diff block (no "Expected:"/"Received:" colon lines)
const TO_EQUAL_OUTPUT = `bun test v1.3.12 (700fc117)

to-equal-fail.test.ts:
1 | import { test, expect } from "bun:test";
2 | test("toEqual fail", () => {
3 |   expect({a: 1, b: 2}).toEqual({a: 1, b: 99});
                           ^
error: expect(received).toEqual(expected)

@@ -2,3 +2,3 @@
    "a": 1,
-   "b": 99,
+   "b": 2,
  }

- Expected  - 1
+ Received  + 1

      at <anonymous> (/private/tmp/bun-test-probe-matchers/to-equal-fail.test.ts:3:24)
(fail) toEqual fail [0.15ms]

 0 pass
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [4.00ms]`;

// toContain — emits "Expected to contain: X" / "Received: [...]"
const TO_CONTAIN_OUTPUT = `bun test v1.3.12 (700fc117)

to-contain-fail.test.ts:
1 | import { test, expect } from "bun:test";
2 | test("toContain fail", () => {
3 |   expect([1, 2, 3]).toContain(99);
                        ^
error: expect(received).toContain(expected)

Expected to contain: 99
Received: [ 1, 2, 3 ]

      at <anonymous> (/private/tmp/bun-test-probe-matchers/to-contain-fail.test.ts:3:21)
(fail) toContain fail [0.12ms]

 0 pass
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [4.00ms]`;

// toMatch — emits "Expected substring or pattern: /x/" / "Received: \"...\""
const TO_MATCH_OUTPUT = `bun test v1.3.12 (700fc117)

to-match-fail.test.ts:
1 | import { test, expect } from "bun:test";
2 | test("toMatch fail", () => {
3 |   expect("hello world").toMatch(/foobar/);
                            ^
error: expect(received).toMatch(expected)

Expected substring or pattern: /foobar/
Received: "hello world"

      at <anonymous> (/private/tmp/bun-test-probe-matchers/to-match-fail.test.ts:3:25)
(fail) toMatch fail [0.16ms]

 0 pass
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [3.00ms]`;

// toThrow — emits "Received function did not throw" / "Received value: X"
const TO_THROW_OUTPUT = `bun test v1.3.12 (700fc117)

to-throw-fail.test.ts:
1 | import { test, expect } from "bun:test";
2 | test("toThrow fail", () => {
3 |   expect(() => 42).toThrow();
                       ^
error: expect(received).toThrow()

Received function did not throw
Received value: 42

      at <anonymous> (/private/tmp/bun-test-probe-matchers/to-throw-fail.test.ts:3:20)
(fail) toThrow fail [0.11ms]

 0 pass
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [3.00ms]`;

// Unhandled TypeError (not a module-load: real error at import time)
const UNHANDLED_TYPE_ERROR_OUTPUT = `bun test v1.3.12 (700fc117)

unhandled-typeerror.test.ts:

# Unhandled error between tests
-------------------------------
1 | import { test } from "bun:test";
2 | // Import time crash
3 | const x: any = null;
4 | x.boom(); // TypeError at import time
    ^
TypeError: null is not an object (evaluating 'x.boom')
      at /private/tmp/bun-test-probe-matchers/unhandled-typeerror.test.ts:4:1
      at loadAndEvaluateModule (2:1)
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [3.00ms]`;

// Unhandled RangeError (different crash type — must produce DIFFERENT signature than TypeError)
const UNHANDLED_RANGE_ERROR_OUTPUT = `bun test v1.3.12 (700fc117)

unhandled-rangeerror.test.ts:

# Unhandled error between tests
-------------------------------
1 | import { test } from "bun:test";
2 | // Import time crash with RangeError
3 | const arr = new Array(-1);
                    ^
RangeError: Array length must be a positive integer of safe magnitude.
      at /private/tmp/bun-test-probe-matchers/unhandled-rangeerror.test.ts:3:17
      at loadAndEvaluateModule (2:1)
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [3.00ms]`;

// TypeScript diagnostic (tsc output — no "(fail)" lines)
const TS_DIAGNOSTIC_OUTPUT = `ts-error.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.`;

// ANSI-wrapped toBe output (simulated — spawnSync is color-free, but insurance)
const ANSI_FAIL_OUTPUT = `\x1b[0mbun test v1.3.12 (700fc117)\x1b[0m

test-probe.test.ts:
\x1b[0merror: expect(received).toBe(expected)\x1b[0m

\x1b[32mExpected: 99\x1b[0m
\x1b[31mReceived: 42\x1b[0m

      at <anonymous> (/private/tmp/test.ts:5:16)
\x1b[31m(fail) ansi wrapped test [0.11ms]\x1b[0m

 0 pass
 1 fail`;

// Test with an "import { MyCustomError }" to verify errorType is not set from echoed source
const CUSTOM_ERROR_IMPORT_OUTPUT = `bun test v1.3.12 (700fc117)

with-custom-error.test.ts:
1 | import { test, expect } from "bun:test";
2 | import { MyCustomError } from "./my-error.ts";
3 | test("uses custom error", () => {
4 |   expect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/private/tmp/bun-test-probe-matchers/with-custom-error.test.ts:4:13)
(fail) uses custom error [0.10ms]

 0 pass
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [3.00ms]`;

// ---------------------------------------------------------------------------
// Real bun test output fixtures (captured from actual bun v1.3.x runs)
// ---------------------------------------------------------------------------

// bun test output for: expect(42).toBe(99)  in "suite one > fails with expected/received"
const EXPECT_FAIL_OUTPUT = `bun test v1.3.12 (700fc117)

test-probe.test.ts:
1 | import { test, expect, describe } from "bun:test";
2 |
3 | describe("suite one", () => {
4 |   test("fails with expected/received", () => {
5 |     expect(42).toBe(99);
                   ^
error: expect(received).toBe(expected)

Expected: 99
Received: 42

      at <anonymous> (/private/tmp/bun-test-probe/test-probe.test.ts:5:16)
(fail) suite one > fails with expected/received [0.11ms]

 0 pass
 2 fail
 2 expect() calls
Ran 2 tests across 1 file. [3.00ms]`;

// bun test output for module-load crash (cannot find module)
const MODULE_LOAD_OUTPUT = `bun test v1.3.12 (700fc117)

test-module-crash2.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module './totally-nonexistent-zzzz.ts' from '/private/tmp/bun-test-probe/test-module-crash2.test.ts'
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [4.00ms]`;

// bun test output for a (fail) line with no Expected/Received (e.g. TypeError)
const TYPE_ERROR_OUTPUT = `bun test v1.3.12 (700fc117)

test-type-error.test.ts:
1 | import { test } from "bun:test";
2 |
3 | test("type error crash", () => {
4 |   const obj: any = null;
                       ^
TypeError: null is not an object (evaluating 'null.nonexistentMethod')
      at <anonymous> (/private/tmp/bun-test-probe/test-type-error.test.ts:4:20)
(fail) type error crash [0.12ms]

 0 pass
 1 fail
Ran 1 test across 1 file. [4.00ms]`;

// Green/empty output
const GREEN_OUTPUT = ` 1 pass\n 0 fail\n Ran 1 test across 1 file. [4.00ms]`;

// ---------------------------------------------------------------------------
// extractFirstFailure
// ---------------------------------------------------------------------------

describe("extractFirstFailure — expect().toBe() failure", () => {
  it("returns non-null for a failing expect", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("assertionId contains the test label", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT);
    expect(d!.assertionId).toBe("suite one > fails with expected/received");
  });

  it("expected value is extracted correctly", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT);
    expect(d!.expected).toBe("99");
  });

  it("actual (received) value is extracted correctly", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT);
    expect(d!.actual).toBe("42");
  });

  it("errorType is AssertionError for expect() failures", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT);
    expect(d!.errorType).toBe("AssertionError");
  });

  it("message contains the error description", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT);
    expect(d!.message).toContain("toBe");
  });

  it("raw field is non-empty and capped at 600 chars", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT);
    expect(d!.raw.length).toBeGreaterThan(0);
    expect(d!.raw.length).toBeLessThanOrEqual(600);
  });
});

describe("extractFirstFailure — label-only (fail) (no Expected/Received)", () => {
  it("returns non-null for TypeError crash", () => {
    const d = extractFirstFailure(TYPE_ERROR_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("assertionId is set to the test label", () => {
    const d = extractFirstFailure(TYPE_ERROR_OUTPUT);
    expect(d!.assertionId).toBe("type error crash");
  });

  it("expected is undefined (no Expected: line)", () => {
    const d = extractFirstFailure(TYPE_ERROR_OUTPUT);
    expect(d!.expected).toBeUndefined();
  });

  it("actual is undefined (no Received: line)", () => {
    const d = extractFirstFailure(TYPE_ERROR_OUTPUT);
    expect(d!.actual).toBeUndefined();
  });

  it("errorType is TypeError", () => {
    const d = extractFirstFailure(TYPE_ERROR_OUTPUT);
    expect(d!.errorType).toBe("TypeError");
  });

  it("message is non-empty", () => {
    const d = extractFirstFailure(TYPE_ERROR_OUTPUT);
    expect(d!.message.length).toBeGreaterThan(0);
  });
});

describe("extractFirstFailure — module-load crash", () => {
  it("returns non-null for module-load error", () => {
    const d = extractFirstFailure(MODULE_LOAD_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("assertionId is <module-load>", () => {
    const d = extractFirstFailure(MODULE_LOAD_OUTPUT);
    expect(d!.assertionId).toBe("<module-load>");
  });

  it("errorType is module-load", () => {
    const d = extractFirstFailure(MODULE_LOAD_OUTPUT);
    expect(d!.errorType).toBe("module-load");
  });

  it("message mentions the missing module", () => {
    const d = extractFirstFailure(MODULE_LOAD_OUTPUT);
    expect(d!.message).toContain("totally-nonexistent-zzzz.ts");
  });
});

describe("extractFirstFailure — green / empty output", () => {
  it("returns null for green test output", () => {
    expect(extractFirstFailure(GREEN_OUTPUT)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractFirstFailure("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(extractFirstFailure("   \n  ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// failureSignature — stability
// ---------------------------------------------------------------------------

describe("failureSignature — stability across timing/path variations", () => {
  // Two outputs for the same logical failure: different timing and tmp path
  const OUTPUT_A = `error: expect(received).toBe(expected)

Expected: 99
Received: 42

      at <anonymous> (/tmp/abc123/test.ts:5:16)
(fail) my test [0.11ms]`;

  const OUTPUT_B = `error: expect(received).toBe(expected)

Expected: 99
Received: 42

      at <anonymous> (/tmp/xyz999/test.ts:5:16)
(fail) my test [12.33ms]`;

  it("same logical failure → identical signatures despite timing/path differences", () => {
    const dA = extractFirstFailure(OUTPUT_A)!;
    const dB = extractFirstFailure(OUTPUT_B)!;
    expect(failureSignature(dA)).toBe(failureSignature(dB));
  });
});

describe("failureSignature — distinguishes different failures", () => {
  const OUTPUT_DIFF_EXPECTED = `error: expect(received).toBe(expected)

Expected: 999
Received: 42

      at <anonymous> (/tmp/test.ts:5:16)
(fail) my test [0.11ms]`;

  const OUTPUT_ORIG = `error: expect(received).toBe(expected)

Expected: 99
Received: 42

      at <anonymous> (/tmp/test.ts:5:16)
(fail) my test [0.11ms]`;

  it("different expected value → different signatures", () => {
    const dA = extractFirstFailure(OUTPUT_ORIG)!;
    const dB = extractFirstFailure(OUTPUT_DIFF_EXPECTED)!;
    expect(failureSignature(dA)).not.toBe(failureSignature(dB));
  });

  it("different test label → different signatures", () => {
    const outputOtherLabel = OUTPUT_ORIG.replace("(fail) my test", "(fail) other test");
    const dA = extractFirstFailure(OUTPUT_ORIG)!;
    const dB = extractFirstFailure(outputOtherLabel)!;
    expect(failureSignature(dA)).not.toBe(failureSignature(dB));
  });
});

// ---------------------------------------------------------------------------
// renderDiagnostic
// ---------------------------------------------------------------------------

describe("renderDiagnostic", () => {
  it("output length is capped at 400 chars", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT)!;
    const rendered = renderDiagnostic(d);
    expect(rendered.length).toBeLessThanOrEqual(400);
  });

  it("contains the expected value", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT)!;
    const rendered = renderDiagnostic(d);
    expect(rendered).toContain("99");
  });

  it("contains the received/actual value", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT)!;
    const rendered = renderDiagnostic(d);
    expect(rendered).toContain("42");
  });

  it("contains the test label", () => {
    const d = extractFirstFailure(EXPECT_FAIL_OUTPUT)!;
    const rendered = renderDiagnostic(d);
    expect(rendered).toContain("suite one > fails with expected/received");
  });

  it("omits Expected/Received lines when undefined", () => {
    const d = extractFirstFailure(TYPE_ERROR_OUTPUT)!;
    const rendered = renderDiagnostic(d);
    expect(rendered).not.toContain("Expected:");
    expect(rendered).not.toContain("Received:");
  });

  it("includes raw snippet as fallback when expected and actual are both undefined", () => {
    // Use the unhandled TypeError which has no Expected/Received lines
    const d = extractFirstFailure(UNHANDLED_TYPE_ERROR_OUTPUT)!;
    expect(d!.expected).toBeUndefined();
    expect(d!.actual).toBeUndefined();
    const rendered = renderDiagnostic(d);
    // Should include something from raw (the error message)
    expect(rendered).toContain("Details:");
    expect(rendered.length).toBeGreaterThan(20);
    // Still capped at 400
    expect(rendered.length).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// New: toEqual matcher extraction
// ---------------------------------------------------------------------------

describe("extractFirstFailure — toEqual diff block", () => {
  it("returns non-null for a failing toEqual", () => {
    const d = extractFirstFailure(TO_EQUAL_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("assertionId is the test label", () => {
    const d = extractFirstFailure(TO_EQUAL_OUTPUT);
    expect(d!.assertionId).toBe("toEqual fail");
  });

  it("errorType is AssertionError", () => {
    const d = extractFirstFailure(TO_EQUAL_OUTPUT);
    expect(d!.errorType).toBe("AssertionError");
  });

  it("captures something in expected from diff block", () => {
    const d = extractFirstFailure(TO_EQUAL_OUTPUT);
    // diff format: minus lines go into expected, plus lines go into actual
    expect(d!.expected).toBeDefined();
    expect(d!.expected!.length).toBeGreaterThan(0);
  });

  it("captures something in actual from diff block", () => {
    const d = extractFirstFailure(TO_EQUAL_OUTPUT);
    expect(d!.actual).toBeDefined();
    expect(d!.actual!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// New: toContain matcher extraction
// ---------------------------------------------------------------------------

describe("extractFirstFailure — toContain output", () => {
  it("returns non-null for a failing toContain", () => {
    const d = extractFirstFailure(TO_CONTAIN_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("assertionId is the test label", () => {
    const d = extractFirstFailure(TO_CONTAIN_OUTPUT);
    expect(d!.assertionId).toBe("toContain fail");
  });

  it("expected contains the value to contain", () => {
    const d = extractFirstFailure(TO_CONTAIN_OUTPUT);
    expect(d!.expected).toBeDefined();
    expect(d!.expected).toContain("99");
  });

  it("actual contains the received array", () => {
    const d = extractFirstFailure(TO_CONTAIN_OUTPUT);
    expect(d!.actual).toBeDefined();
    expect(d!.actual).toContain("1, 2, 3");
  });
});

// ---------------------------------------------------------------------------
// New: toMatch matcher extraction
// ---------------------------------------------------------------------------

describe("extractFirstFailure — toMatch output", () => {
  it("returns non-null for a failing toMatch", () => {
    const d = extractFirstFailure(TO_MATCH_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("assertionId is the test label", () => {
    const d = extractFirstFailure(TO_MATCH_OUTPUT);
    expect(d!.assertionId).toBe("toMatch fail");
  });

  it("expected contains the pattern", () => {
    const d = extractFirstFailure(TO_MATCH_OUTPUT);
    expect(d!.expected).toBeDefined();
    expect(d!.expected).toContain("foobar");
  });

  it("actual contains the received string", () => {
    const d = extractFirstFailure(TO_MATCH_OUTPUT);
    expect(d!.actual).toBeDefined();
    expect(d!.actual).toContain("hello world");
  });
});

// ---------------------------------------------------------------------------
// New: toThrow matcher extraction
// ---------------------------------------------------------------------------

describe("extractFirstFailure — toThrow output", () => {
  it("returns non-null for a failing toThrow", () => {
    const d = extractFirstFailure(TO_THROW_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("assertionId is the test label", () => {
    const d = extractFirstFailure(TO_THROW_OUTPUT);
    expect(d!.assertionId).toBe("toThrow fail");
  });

  it("actual captures 'Received function did not throw'", () => {
    const d = extractFirstFailure(TO_THROW_OUTPUT);
    expect(d!.actual).toBeDefined();
    expect(d!.actual).toContain("did not throw");
  });
});

// ---------------------------------------------------------------------------
// New: unhandled errors — different crashes → different signatures
// ---------------------------------------------------------------------------

describe("extractFirstFailure — unhandled non-module errors", () => {
  it("returns non-null for unhandled TypeError", () => {
    const d = extractFirstFailure(UNHANDLED_TYPE_ERROR_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("errorType is TypeError for unhandled TypeError", () => {
    const d = extractFirstFailure(UNHANDLED_TYPE_ERROR_OUTPUT);
    expect(d!.errorType).toBe("TypeError");
  });

  it("assertionId is NOT <module-load> for non-module crashes", () => {
    const d = extractFirstFailure(UNHANDLED_TYPE_ERROR_OUTPUT);
    expect(d!.assertionId).not.toBe("<module-load>");
  });

  it("message contains the real error text", () => {
    const d = extractFirstFailure(UNHANDLED_TYPE_ERROR_OUTPUT);
    expect(d!.message).toContain("null is not an object");
  });

  it("two different unhandled errors produce DIFFERENT signatures", () => {
    const dType = extractFirstFailure(UNHANDLED_TYPE_ERROR_OUTPUT)!;
    const dRange = extractFirstFailure(UNHANDLED_RANGE_ERROR_OUTPUT)!;
    expect(failureSignature(dType)).not.toBe(failureSignature(dRange));
  });
});

// ---------------------------------------------------------------------------
// New: Cannot find module still uses <module-load> assertionId
// ---------------------------------------------------------------------------

describe("extractFirstFailure — Cannot find module still works", () => {
  it("assertionId is <module-load> for Cannot find module", () => {
    const { MODULE_LOAD_OUTPUT } = { MODULE_LOAD_OUTPUT: `bun test v1.3.12 (700fc117)

test-module-crash2.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module './totally-nonexistent-zzzz.ts' from '/private/tmp/bun-test-probe/test-module-crash2.test.ts'
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [4.00ms]` };
    const d = extractFirstFailure(MODULE_LOAD_OUTPUT);
    expect(d!.assertionId).toBe("<module-load>");
    expect(d!.errorType).toBe("module-load");
  });
});

// ---------------------------------------------------------------------------
// New: TypeScript diagnostic parsing (Tier-2 typecheck output)
// ---------------------------------------------------------------------------

describe("extractFirstFailure — TypeScript diagnostic (tsc output)", () => {
  it("returns non-null for tsc error output", () => {
    const d = extractFirstFailure(TS_DIAGNOSTIC_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("errorType is the TS code", () => {
    const d = extractFirstFailure(TS_DIAGNOSTIC_OUTPUT);
    expect(d!.errorType).toBe("TS2322");
  });

  it("message contains the TS error description", () => {
    const d = extractFirstFailure(TS_DIAGNOSTIC_OUTPUT);
    expect(d!.message).toContain("not assignable");
  });

  it("assertionId contains the file and location", () => {
    const d = extractFirstFailure(TS_DIAGNOSTIC_OUTPUT);
    expect(d!.assertionId).toContain("ts-error.ts");
  });
});

// ---------------------------------------------------------------------------
// New: ANSI-wrapped output parses correctly
// ---------------------------------------------------------------------------

describe("extractFirstFailure — ANSI-wrapped output", () => {
  it("returns non-null for ANSI-colored output", () => {
    const d = extractFirstFailure(ANSI_FAIL_OUTPUT);
    expect(d).not.toBeNull();
  });

  it("assertionId is extracted correctly from ANSI output", () => {
    const d = extractFirstFailure(ANSI_FAIL_OUTPUT);
    expect(d!.assertionId).toBe("ansi wrapped test");
  });

  it("expected is extracted correctly from ANSI output", () => {
    const d = extractFirstFailure(ANSI_FAIL_OUTPUT);
    expect(d!.expected).toBe("99");
  });

  it("actual is extracted correctly from ANSI output", () => {
    const d = extractFirstFailure(ANSI_FAIL_OUTPUT);
    expect(d!.actual).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// New: Fix 4 — errorType not set from echoed import source
// ---------------------------------------------------------------------------

describe("extractFirstFailure — errorType not set from echoed import source", () => {
  it("errorType is AssertionError (not MyCustomError) when source echoes custom error import", () => {
    const d = extractFirstFailure(CUSTOM_ERROR_IMPORT_OUTPUT);
    expect(d).not.toBeNull();
    // The echoed source `import { MyCustomError } ...` should NOT pollute errorType
    expect(d!.errorType).toBe("AssertionError");
    expect(d!.errorType).not.toBe("MyCustomError");
  });
});
