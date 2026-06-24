import { describe, expect, it } from "bun:test";
import {
  extractFirstFailure,
  failureSignature,
  renderDiagnostic,
} from "../src/verify/failure-extract.ts";

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
});
