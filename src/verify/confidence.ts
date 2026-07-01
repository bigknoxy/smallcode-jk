import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "./types.ts";

/**
 * Static-confidence ladder for the ORACLE-FREE path.
 *
 * When NO test covers the change, smallcode cannot claim correctness — but it can
 * report, deterministically, whether the edit at least did not break the build.
 * The honest middle ground between a false "verified" and a bare "unverified".
 *
 * IMPORTANT (and stated in the report): a SAFETY signal, not a CORRECTNESS one. A
 * wrong operator / off-by-one / inverted condition parses and typechecks
 * clean — only a test catches those. The ladder, weakest→strongest:
 *   broken      → a source file does not even PARSE (a structural break we caught)
 *   parses      → every source file parses, but no typecheck ran (no tsconfig)
 *   type-clean  → parses AND `tsc` ran with no real type errors
 * `unknown` = nothing checkable at all.
 */
export type ConfidenceLevel = "verified" | "type-clean" | "parses" | "broken" | "unknown";

export interface StaticConfidence {
  level: ConfidenceLevel;
  /** Human-readable checks behind the level — for honest user-facing reporting. */
  signals: string[];
}

const SRC_RE = /\.[cm]?[jt]sx?$/;
function listSourceFiles(root: string, rel = "", out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, rel));
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === ".smallcode") continue;
    const r = rel ? `${rel}/${name}` : name;
    const abs = join(root, r);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) listSourceFiles(root, r, out);
    else if (SRC_RE.test(name) && !/\.(test|spec)\./.test(name)) out.push(r);
  }
  return out;
}

/** Parse-check one file via Bun's transpiler. Returns an error message or null. */
function parseError(absPath: string, code: string): string | null {
  const loader = absPath.endsWith("x") ? "tsx" : absPath.match(/\.[cm]?ts$/) ? "ts" : "jsx";
  try {
    new Bun.Transpiler({ loader }).transformSync(code);
    return null;
  } catch (e) {
    return e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
  }
}

/**
 * Grade confidence from deterministic checks when there is no test oracle. Takes
 * the typecheck result already computed by the oracle (re-running it is wasteful).
 * Parse-checks every source file first — that universal signal needs no tsconfig,
 * so a structural break is caught even on a bare repo where `tsc` is skipped.
 */
export async function computeStaticConfidence(
  repoRoot: string,
  typecheck: CheckResult | undefined,
): Promise<StaticConfidence> {
  const signals: string[] = ["no test covers this change → NOT correctness-verified"];

  // 1. Parse-check (universal — no config needed).
  const files = listSourceFiles(repoRoot);
  for (const rel of files) {
    const abs = join(repoRoot, rel);
    let code: string;
    try {
      code = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const err = parseError(abs, code);
    if (err) {
      return { level: "broken", signals: [...signals, `parse error in ${rel}: ${err}`] };
    }
  }
  signals.push(files.length > 0 ? `parses: ${files.length} source file(s) OK` : "parses: no source files found");

  // 2. Typecheck (only meaningful when it actually ran).
  const tcRan = typecheck?.status === "passed";
  if (tcRan) signals.push("typescript: no errors");
  else if (typecheck) signals.push("typescript: skipped (no/invalid tsconfig)");

  const level: ConfidenceLevel = files.length === 0 ? "unknown" : tcRan ? "type-clean" : "parses";
  return { level, signals };
}

/** One-line honest summary for the CLI / loop, e.g. for an unverified finish. */
export function renderConfidence(c: StaticConfidence): string {
  return `Static confidence: ${c.level} (${c.signals.join("; ")})`;
}
