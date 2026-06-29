/**
 * Pure-string failure extraction from `bun test` output.
 *
 * Extracts the first failing assertion's expected/received values, error type,
 * and test label so the agent sees a structured diagnostic instead of a raw
 * 600-char slice.  No I/O — all functions take strings, return strings/objects.
 */

export interface FailureDiagnostic {
  /** "describe > test" label, or first failing test name, or "<module-load>" */
  assertionId: string;
  expected?: string;
  actual?: string;
  message: string;
  /** "TypeError" | "SyntaxError" | "AssertionError" | "module-load" | "TSxxxx" | ... */
  errorType?: string;
  /** Trimmed span of the failure block, capped ~600 chars */
  raw: string;
  /**
   * R2 externalize-localization. Absolute path of the first SOURCE stack frame
   * (a runtime throw points here, e.g. `at risky (/repo/src/calc.ts:5:35)`).
   * Populated ONLY when the trace reaches a non-test, non-node_modules source
   * file — a pure assertion mismatch's trace stops at the test line, so this stays
   * undefined and no (wrong) location is surfaced. The loop maps it to a pinned
   * window so the small model gets the WHERE it cannot itself localize.
   */
  sourceFile?: string;
  /** 1-based line of the source frame above. */
  sourceLine?: number;
}

/**
 * R2: pull the first SOURCE stack frame from `bun test` output. Stack lines look
 * like `      at <name> (/abs/path/file.ts:LINE:COL)` or `      at /abs/file.ts:L:C`.
 * We return the FIRST frame whose file is real source — skipping test/spec files
 * (a value-assertion trace stops there and is NOT the bug), node_modules, and
 * bun/node internals. Returns null when no source frame exists (the common case
 * for pure assertion mismatches — deliberately so, to avoid surfacing the test
 * line as a false bug location). Pure; exported for testing.
 */
export function extractSourceFrame(output: string): { file: string; line: number } | null {
  const cleaned = output.replace(/\x1b\[[0-9;]*m/g, "");
  // `at [name ](path:line:col)` OR `at path:line:col`
  const frameRe = /^\s*at\s+(?:.*?\()?((?:\/|[A-Za-z]:\\)[^()\n]+?):(\d+):(\d+)\)?\s*$/gm;
  for (const m of cleaned.matchAll(frameRe)) {
    const file = m[1] ?? "";
    if (!file) continue;
    if (/node_modules|[/\\]bun:|^bun:|node:internal/.test(file)) continue;
    if (isTestSpecPath(file)) continue;
    const line = parseInt(m[2] ?? "0", 10);
    if (line > 0) return { file, line };
  }
  return null;
}

/** Test/spec file heuristic, kept local to avoid a cross-module import. */
function isTestSpecPath(p: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$|[/\\]__tests__[/\\]|[/\\]tests?[/\\]/.test(p);
}

/** Strip ANSI escape sequences from output (insurance against colored output). */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI strip
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Extract the first failure diagnostic from `bun test` stdout+stderr output.
 * Returns null when the output has no failures (green / no tests / empty).
 */
export function extractFirstFailure(output: string): FailureDiagnostic | null {
  if (!output || output.trim() === "") return null;

  // Fix 5: strip ANSI at entry point (latent insurance)
  output = stripAnsi(output);

  // R2: first source stack frame, if the trace reaches one (runtime throws do;
  // pure assertion mismatches do not). Spread into the throw/fail returns below.
  const frame = extractSourceFrame(output);
  const frameFields = frame ? { sourceFile: frame.file, sourceLine: frame.line } : {};

  // -------------------------------------------------------------------------
  // TypeScript diagnostic path (Tier-2 typecheck output):
  //   "path/file.ts(12,3): error TS2322: message"
  //   No "(fail)" lines — this is tsc output, not bun test output.
  // -------------------------------------------------------------------------
  const tsDiagRe = /^(.+\.tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/m;
  const tsDiagMatch = output.match(tsDiagRe);
  if (tsDiagMatch && !hasFail(output)) {
    const [, filePath, line, col, tsCode, tsMessage] = tsDiagMatch;
    const raw = output.trim().slice(0, 600);
    return {
      assertionId: `${filePath ?? "unknown"}(${line},${col})`,
      message: `${tsCode}: ${tsMessage}`,
      errorType: tsCode ?? "typecheck",
      raw,
    };
  }

  // -------------------------------------------------------------------------
  // Module-load / unhandled-error path:
  //   "# Unhandled error between tests" + some error line
  //   No (fail) line with a test name; no Expected/Received.
  // -------------------------------------------------------------------------
  const unhandledSection = /# Unhandled error between tests/i;
  if (unhandledSection.test(output) || !hasFail(output)) {
    // Only treat as module-load shortcut when it's literally "Cannot find module"
    const moduleLoadRe = /error:\s+Cannot find module\s+'([^']+)'/i;
    const modMatch = output.match(moduleLoadRe);
    if (modMatch) {
      const raw = extractRawSpan(output, 0);
      return {
        assertionId: "<module-load>",
        message: `Cannot find module '${modMatch[1]}'`,
        errorType: "module-load",
        raw,
      };
    }

    // For other unhandled errors, extract the real error line so the model sees
    // the actual problem and so failureSignature VARIES per distinct error.
    if (unhandledSection.test(output)) {
      // Look for lines like "TypeError: ..." or "error: ..." inside the unhandled block
      const realErrorRe = /^(?:error:\s+.+|(?:\w*(?:Error|Exception)):\s+.+)$/m;
      const errMatch = output.match(realErrorRe);
      const errLine = errMatch ? (errMatch[0] ?? "").trim() : "Unhandled error";
      // Derive errorType from the real error line
      const etMatch = errLine.match(/^(\w*(?:Error|Exception))\b/);
      const errorType = etMatch ? etMatch[1] : "UnhandledError";
      // Use the first ~60 chars of the error message as the assertionId so
      // different crashes produce different signatures.
      const assertionId = errLine.slice(0, 60);
      const raw = extractRawSpan(output, 0);
      return {
        assertionId,
        message: errLine,
        errorType,
        raw,
        ...frameFields,
      };
    }

    // No (fail) and no unhandled section — nothing to parse
    return null;
  }

  // -------------------------------------------------------------------------
  // Normal test failure: find the first "(fail)" or "✗" label line.
  //
  // Bun format (observed on v1.3.x):
  //   error: expect(received).toBe(expected)\n
  //   \n
  //   Expected: 99\n
  //   Received: 42\n
  //   \n
  //      at …\n
  //   (fail) suite one > fails with expected/received [0.11ms]
  //
  //   error: expect(received).toEqual(expected)
  //   @@ -2,3 +2,3 @@
  //       "a": 1,
  //   -   "b": 99,
  //   +   "b": 2,
  //     }
  //   - Expected  - 1
  //   + Received  + 1
  //   (fail) toEqual fail [0.15ms]
  //
  //   error: expect(received).toContain(expected)
  //   Expected to contain: 99
  //   Received: [ 1, 2, 3 ]
  //   (fail) toContain fail [0.12ms]
  //
  //   error: expect(received).toMatch(expected)
  //   Expected substring or pattern: /foobar/
  //   Received: "hello world"
  //   (fail) toMatch fail [0.16ms]
  //
  //   error: expect(received).toThrow()
  //   Received function did not throw
  //   Received value: 42
  //   (fail) toThrow fail [0.11ms]
  //
  //   OR for non-assertion errors:
  //   TypeError: null is not an object …\n
  //      at …\n
  //   (fail) type error crash [0.12ms]
  // -------------------------------------------------------------------------
  const failRe = /^\s*(?:\(fail\)|✗)\s+(.+?)\s+\[\d+(?:\.\d+)?ms\]\s*$/m;
  const failMatch = output.match(failRe);
  if (!failMatch) return null;

  const assertionId = (failMatch[1] ?? "").trim();
  const failPos = failMatch.index ?? 0;

  // Grab the block of text BEFORE this (fail) line — that's where error details live.
  const blockBefore = output.slice(0, failPos);

  // Find the "error:" anchor closest to the (fail) line (search from end of blockBefore).
  const errorLineRe = /^(?:error|TypeError|SyntaxError|RangeError|ReferenceError|URIError|EvalError|AssertionError|\w*Error):\s*.+$/m;
  const errorMatches = [...blockBefore.matchAll(new RegExp(errorLineRe.source, "gm"))];
  const lastError = errorMatches.at(-1);

  let message = "";
  let expected: string | undefined;
  let actual: string | undefined;
  let errorType: string | undefined;

  if (lastError) {
    const errorLine = lastError[0] ?? "";
    message = errorLine.trim();

    // Detect error type from the error line
    const errorTypeMatch = message.match(/^(\w*(?:Error|Exception))\b/);
    if (errorTypeMatch) {
      errorType = errorTypeMatch[1];
    } else if (message.startsWith("error:")) {
      // "error: expect(received).toBe(expected)" — this is an AssertionError
      errorType = "AssertionError";
    }

    // Search for expected/actual values after the error line.
    // Handles multiple bun matcher output formats:
    const afterError = blockBefore.slice((lastError.index ?? 0) + errorLine.length);

    // Format 1 (toBe): "Expected: X" / "Received: X"
    const expectedMatch = afterError.match(/^Expected:\s*(.+)$/m);
    const receivedMatch = afterError.match(/^(?:Received|Actual):\s*(.+)$/m);

    // Format 2 (toContain/toMatch): "Expected to contain: X" / "Expected substring or pattern: X"
    const expectedToContainMatch = afterError.match(/^Expected (?:to contain|substring or pattern):\s*(.+)$/m);

    // Format 3 (toThrow): "Received function did not throw" / "Received value: X"
    const receivedValueMatch = afterError.match(/^Received value:\s*(.+)$/m);
    const didNotThrowMatch = afterError.match(/^(Received function did not throw)$/m);

    // Format 4 (toEqual): unified diff "- Expected  - N" / "+ Received  + N"
    // The diff lines look like:
    //   @@ -2,3 +2,3 @@
    //       "a": 1,
    //   -   "b": 99,
    //   +   "b": 2,
    //     }
    //   - Expected  - 1
    //   + Received  + 1
    const diffExpectedLines = [...afterError.matchAll(/^-\s+(.+)$/gm)]
      .map((m) => m[1] ?? "")
      .filter((l) => !l.startsWith("Expected") && !l.startsWith("Received"));
    const diffReceivedLines = [...afterError.matchAll(/^\+\s+(.+)$/gm)]
      .map((m) => m[1] ?? "")
      .filter((l) => !l.startsWith("Expected") && !l.startsWith("Received"));

    if (expectedMatch) {
      expected = expectedMatch[1]?.trim();
    } else if (expectedToContainMatch) {
      expected = expectedToContainMatch[1]?.trim();
    } else if (diffExpectedLines.length > 0) {
      // Compact the diff lines into a short summary
      expected = diffExpectedLines.join(", ").slice(0, 120);
    }

    if (didNotThrowMatch) {
      // toThrow: "Received function did not throw" is the primary diagnostic —
      // more informative than the "Received value" line.
      actual = didNotThrowMatch[1]?.trim();
    } else if (receivedMatch) {
      actual = receivedMatch[1]?.trim();
    } else if (receivedValueMatch) {
      actual = receivedValueMatch[1]?.trim();
    } else if (diffReceivedLines.length > 0) {
      actual = diffReceivedLines.join(", ").slice(0, 120);
    }
  } else {
    // Fallback: use the fail line itself as the message
    message = `Test failed: ${assertionId}`;
  }

  // Fix 4: derive errorType only from lines that are themselves error headers,
  // not from echoed source code (e.g. `import { MyError } from ...`).
  // Anchor scan to lines that START with "error:" or an Error/Exception type name.
  if (!errorType) {
    const anchoredErrorTypeRe = /^(?:error|\w*Error|\w*Exception):/m;
    const anchoredMatch = blockBefore.match(anchoredErrorTypeRe);
    if (anchoredMatch) {
      const etm = anchoredMatch[0].match(/^(\w*(?:Error|Exception))\b/);
      if (etm) errorType = etm[1];
    }
  }

  // Raw span: from last error anchor to just past the (fail) line, capped ~600
  const spanStart = lastError ? Math.max(0, (lastError.index ?? 0) - 50) : Math.max(0, failPos - 300);
  const spanEnd = failPos + (failMatch[0]?.length ?? 0);
  const raw = output.slice(spanStart, spanEnd).trim().slice(0, 600);

  return {
    assertionId,
    expected,
    actual,
    message,
    errorType,
    raw,
    // Only attach a location when this failure has NO expected/actual (a runtime
    // throw, not a value mismatch). A value-mismatch trace points at the test
    // line, not the bug — surfacing it would mislead, so suppress it there.
    ...(expected === undefined && actual === undefined ? frameFields : {}),
  };
}

function hasFail(output: string): boolean {
  return /^\s*(?:\(fail\)|✗)\s+.+\s+\[\d+(?:\.\d+)?ms\]/m.test(output);
}

function extractRawSpan(output: string, _start: number): string {
  return output.trim().slice(0, 600);
}

/**
 * Stable hash of a failure diagnostic for stall detection.
 *
 * Normalizes away:
 * - `[Nms]` timing suffixes
 * - absolute paths and /tmp/... paths
 * - hex addresses (0x1a2b3c)
 * - UUIDs / random IDs (long hex strings)
 * - line:col numbers in stack traces
 * - trailing whitespace
 *
 * Returns the same string for the same logical failure across turns.
 */
export function failureSignature(d: FailureDiagnostic): string {
  const normalize = (s: string): string =>
    s
      // Strip [Nms] timing annotations
      .replace(/\[\d+(?:\.\d+)?ms\]/g, "")
      // Strip absolute paths (keep just filename)
      .replace(/\/[^\s'"]+\/([^/\s'"]+)/g, "<path>/$1")
      // Strip hex addresses like 0x1a2b3c4d
      .replace(/\b0x[0-9a-fA-F]{4,}\b/g, "<addr>")
      // Strip UUIDs
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
      // Strip line:col from stack traces (:12:34)
      .replace(/:\d+:\d+/g, ":<loc>")
      // Normalize whitespace
      .replace(/\s+/g, " ")
      .trim();

  const parts = [
    `type:${d.errorType ?? "unknown"}`,
    `id:${normalize(d.assertionId)}`,
    `exp:${normalize(d.expected ?? "")}`,
    `act:${normalize(d.actual ?? "")}`,
    // Include first line of message (strips timing/paths)
    `msg:${normalize((d.message ?? "").split("\n")[0] ?? "")}`,
  ];

  return parts.join("|");
}

/**
 * Compact model-facing diagnostic block for use in turn prompts.
 * Capped at ~400 chars to keep prompts lean.
 *
 * When BOTH expected and actual are undefined, falls back to a trimmed `d.raw`
 * snippet so the model always sees something concrete — prevents redraft-blind.
 */
export function renderDiagnostic(d: FailureDiagnostic): string {
  const lines: string[] = [];

  lines.push(`Test: ${d.assertionId}`);
  if (d.errorType) lines.push(`Error: ${d.errorType}`);
  lines.push(`Message: ${d.message.slice(0, 120)}`);
  if (d.expected !== undefined) lines.push(`Expected: ${d.expected}`);
  if (d.actual !== undefined) lines.push(`Received: ${d.actual}`);

  // When we have no expected/actual, include a trimmed raw snippet so the model
  // always gets something concrete to reason about.
  if (d.expected === undefined && d.actual === undefined && d.raw) {
    const rawSnippet = d.raw.slice(0, 200).trim();
    if (rawSnippet) lines.push(`Details:\n${rawSnippet}`);
  }

  const block = lines.join("\n");
  // Cap at ~400 chars
  return block.slice(0, 400);
}
