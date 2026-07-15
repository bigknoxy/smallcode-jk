import type { CodeSymbol } from "./types.ts";

// ---------------------------------------------------------------------------
// Coupled module-level declaration surfacer
// ---------------------------------------------------------------------------
//
// Some bugs need edits at TWO coupled sites in the same file: the target
// FUNCTION plus a MODULE-LEVEL const/let/var it references (e.g. a lookup
// table or a regex the function walks). Today's pipeline (pickTargetFunction
// + buildContext) only ever surfaces the function — it has no notion that a
// module-level binding is "coupled" to it. This module is a pure, read-only
// signal that scans a file's TEXT (not the extractor's symbol table, which
// deliberately does not capture non-exported top-level consts) for such
// bindings and reports the ones the target function's body actually
// references. It does not mutate anything or feed into the agent loop yet —
// it is a measuring-stick primitive for scripts/coupled-site-accuracy.ts.

/** A module-level binding (const/let/var) the target function references. */
export interface CoupledDecl {
  name: string;
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
}

/** Escape a string for safe use inside a `new RegExp(...)` pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a top-level (non-indented) `const`/`let`/`var` binding declaration. */
const TOP_LEVEL_DECL_RE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;

// Cap on how many lines the brace/paren/bracket balance scan will walk before
// giving up — guards against a pathological file leaving the scan unbounded.
const MAX_BALANCE_SCAN_LINES = 5000;

/**
 * Best-effort end-line for a module-level decl: walk forward from the decl
 * line counting `{`/`[`/`(` as +1 and `}`/`]`/`)` as -1, stopping at the first
 * line where the running balance returns to 0 having seen at least one opener.
 * A decl with no bracket on its own line (a scalar) ends on its own line.
 */
function findDeclEndLine(lines: string[], startIdx: number): number {
  let balance = 0;
  let sawOpener = false;
  const limit = Math.min(lines.length, startIdx + MAX_BALANCE_SCAN_LINES);
  for (let i = startIdx; i < limit; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{" || ch === "[" || ch === "(") {
        balance += 1;
        sawOpener = true;
      } else if (ch === "}" || ch === "]" || ch === ")") {
        balance -= 1;
      }
    }
    if (sawOpener && balance <= 0) return i + 1; // 1-based
    if (!sawOpener && i === startIdx) {
      // No bracket at all on the decl's own line — treat as a scalar decl.
      // Keep scanning only if a later line on the *same statement* opens a
      // bracket (e.g. a multi-line initializer); otherwise stop here.
    }
  }
  // No balanced closure found (or a scalar decl with no brackets at all):
  // fall back to the decl's own line.
  return sawOpener ? limit : startIdx + 1;
}

/**
 * Surface the module-level const/let/var declarations that the target
 * function's body references — the "coupled sites" a fix at that function
 * alone would miss.
 *
 * @param content File source text.
 * @param symbols Extracted symbols for the file (from extractSymbols).
 * @param targetFnName Name of the located target function/method, if any.
 */
export function surfaceCoupledDecls(
  content: string,
  symbols: CodeSymbol[],
  targetFnName: string | undefined,
): CoupledDecl[] {
  if (targetFnName === undefined) return [];

  const targetSym = symbols.find(
    (s) => s.name === targetFnName && (s.kind === "function" || s.kind === "method"),
  );
  if (!targetSym) return [];

  const lines = content.split("\n");

  // 1. Find every top-level (non-indented) const/let/var binding line.
  const candidates: { name: string; startLine: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = TOP_LEVEL_DECL_RE.exec(line);
    if (m?.[1]) {
      candidates.push({ name: m[1], startLine: i + 1 });
    }
  }

  // 2. Keep only bindings whose decl line falls OUTSIDE the target fn's range
  //    (i.e. genuinely module-level, not a local declared inside the fn body).
  const outside = candidates.filter(
    (c) => c.startLine < targetSym.line || c.startLine > targetSym.endLine,
  );

  // 3. Keep only bindings the target fn's BODY actually references.
  const bodyLines = lines.slice(targetSym.line - 1, targetSym.endLine);
  const body = bodyLines.join("\n");

  const referenced = outside.filter((c) => {
    const nameRe = new RegExp(`\\b${escapeRegExp(c.name)}\\b`);
    return nameRe.test(body);
  });

  // 4. Compute each surviving binding's endLine via brace/paren/bracket balance.
  const result: CoupledDecl[] = referenced.map((c) => ({
    name: c.name,
    startLine: c.startLine,
    endLine: findDeclEndLine(lines, c.startLine - 1),
  }));

  result.sort((a, b) => a.startLine - b.startLine);
  return result;
}
