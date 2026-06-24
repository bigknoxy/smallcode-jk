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
  /** "TypeError" | "SyntaxError" | "AssertionError" | "module-load" | ... */
  errorType?: string;
  /** Trimmed span of the failure block, capped ~600 chars */
  raw: string;
}

/**
 * Extract the first failure diagnostic from `bun test` stdout+stderr output.
 * Returns null when the output has no failures (green / no tests / empty).
 */
export function extractFirstFailure(output: string): FailureDiagnostic | null {
  if (!output || output.trim() === "") return null;

  // -------------------------------------------------------------------------
  // Module-load / unhandled-error path:
  //   "# Unhandled error between tests" + "error: Cannot find module …"
  //   No (fail) line with a test name; no Expected/Received.
  // -------------------------------------------------------------------------
  const moduleLoadRe = /error:\s+Cannot find module\s+'([^']+)'/i;
  const unhandledSection = /# Unhandled error between tests/i;
  if (unhandledSection.test(output) || (moduleLoadRe.test(output) && !hasFail(output))) {
    const modMatch = output.match(moduleLoadRe);
    const msg = modMatch ? `Cannot find module '${modMatch[1]}'` : "Module load error";
    const raw = extractRawSpan(output, 0);
    return {
      assertionId: "<module-load>",
      message: msg,
      errorType: "module-load",
      raw,
    };
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

    // Search for Expected:/Received: lines after the error line
    const afterError = blockBefore.slice((lastError.index ?? 0) + errorLine.length);
    const expectedMatch = afterError.match(/^Expected:\s*(.+)$/m);
    const receivedMatch = afterError.match(/^(?:Received|Actual):\s*(.+)$/m);

    if (expectedMatch) expected = expectedMatch[1]?.trim();
    if (receivedMatch) actual = receivedMatch[1]?.trim();
  } else {
    // Fallback: use the fail line itself as the message
    message = `Test failed: ${assertionId}`;
  }

  // Also scan for errorType in the broader block if not found yet
  if (!errorType) {
    const anyErrorType = blockBefore.match(/\b(\w*(?:Error|Exception))\b/);
    if (anyErrorType) errorType = anyErrorType[1];
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
 */
export function renderDiagnostic(d: FailureDiagnostic): string {
  const lines: string[] = [];

  lines.push(`Test: ${d.assertionId}`);
  if (d.errorType) lines.push(`Error: ${d.errorType}`);
  lines.push(`Message: ${d.message.slice(0, 120)}`);
  if (d.expected !== undefined) lines.push(`Expected: ${d.expected}`);
  if (d.actual !== undefined) lines.push(`Received: ${d.actual}`);

  const block = lines.join("\n");
  // Cap at ~400 chars
  return block.slice(0, 400);
}
