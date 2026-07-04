// Lever 2 — static import-resolution gate. Proactively catches HALLUCINATED
// imports (the dogfood `std/strings` failure: a small model invents a module
// that does not exist, then loops re-emitting it because the only feedback is a
// raw "Cannot find module" from a full test run). This module extracts the
// import specifiers a turn's edit INTRODUCED and resolves each against ground
// truth — relative paths against the filesystem, bare packages against
// package.json deps + node_modules (via Bun's resolver) — so the loop can reject
// the edit BEFORE it lands and hand the model a crisp "does not resolve;
// available deps: …" message. Pure extraction is separated from filesystem
// resolution so the parser is unit-testable without a repo.

import path from "node:path";

/** Node builtins that resolve without a dependency (with or without the node: prefix). */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
  "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/**
 * Extract module specifiers from ES-import / re-export / require / dynamic-import
 * forms. Pure (regex-based, no parse tree) and conservative — it only matches the
 * common static forms a small model emits, and returns specifiers in first-seen
 * order, deduplicated. Comment/string false-positives are acceptable: the resolver
 * treats a spurious specifier that DOES resolve as fine, and the gate only fires
 * on NEW specifiers introduced by the edit (see {@link diffNewSpecifiers}).
 */
export function extractImportSpecifiers(source: string): string[] {
  // `import ... from "x"`, `export ... from "x"`, `import "x"` (side-effect),
  // `require("x")`, dynamic `import("x")`. Collect every match with its source
  // position so the result is in true first-seen order across all forms.
  const fromRe = /\b(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g;
  const bareImportRe = /\bimport\s*["']([^"']+)["']/g;
  const callRe = /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  const hits: Array<{ index: number; spec: string }> = [];
  for (const re of [fromRe, bareImportRe, callRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (m[1] !== undefined) hits.push({ index: m.index, spec: m[1] });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const specs: string[] = [];
  const seen = new Set<string>();
  for (const { spec } of hits) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }
  return specs;
}

/** True when the specifier is a Node/Bun builtin (needs no dependency). */
export function isBuiltinSpecifier(spec: string): boolean {
  if (spec.startsWith("node:") || spec.startsWith("bun:")) return true;
  return NODE_BUILTINS.has(spec);
}

/** True for a relative or absolute filesystem specifier (resolved against files). */
export function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

/**
 * The package-root of a bare specifier — the part that must appear in
 * package.json. `lodash/fp` → `lodash`; `@scope/pkg/sub` → `@scope/pkg`. Pure.
 */
export function packageRootOf(spec: string): string {
  const parts = spec.split("/");
  if (spec.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? spec;
}

/** Specifiers present in `newSource` but not in `oldSource` — the edit's additions. */
export function diffNewSpecifiers(oldSource: string, newSource: string): string[] {
  const old = new Set(extractImportSpecifiers(oldSource));
  return extractImportSpecifiers(newSource).filter((s) => !old.has(s));
}

/** Read the union of every dependency name declared in package.json (empty on any error). */
async function readDeclaredDeps(repoRoot: string): Promise<Set<string>> {
  const deps = new Set<string>();
  try {
    const raw = await Bun.file(path.join(repoRoot, "package.json")).text();
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const obj = pkg[field];
      if (obj && typeof obj === "object") for (const name of Object.keys(obj)) deps.add(name);
    }
  } catch {
    // No/invalid package.json → no declared deps; bare specifiers rely on Bun.resolveSync.
  }
  return deps;
}

/**
 * Resolve one specifier against ground truth. Conservative — returns true (treat
 * as OK) unless we are confident it does NOT exist, to keep false-rejects near
 * zero on a lever meant to ship default-off then promote:
 *   • builtin → always OK.
 *   • relative/absolute → Bun.resolveSync from the editing file's directory.
 *   • bare → OK if its package-root is DECLARED in package.json (installed-or-not
 *     is not our concern — a declared dep is a real intent), else Bun.resolveSync
 *     from repoRoot (catches installed-but-undeclared). Only when BOTH fail is it
 *     flagged unresolved — the hallucinated-module signal.
 */
export function resolveSpecifier(
  spec: string,
  fromAbsFile: string,
  repoRoot: string,
  declaredDeps: Set<string>,
): boolean {
  if (isBuiltinSpecifier(spec)) return true;
  if (isRelativeSpecifier(spec)) {
    try {
      Bun.resolveSync(spec, path.dirname(fromAbsFile));
      return true;
    } catch {
      return false;
    }
  }
  // Bare package specifier.
  if (declaredDeps.has(packageRootOf(spec))) return true;
  try {
    Bun.resolveSync(spec, repoRoot);
    return true;
  } catch {
    return false;
  }
}

export interface ImportCheckResult {
  /** Specifiers the edit INTRODUCED that do not resolve — the hallucinated imports. */
  unresolved: string[];
  /** Declared dependency names, for a "use one of these" hint in the feedback. */
  availableDeps: string[];
}

/**
 * Check the imports an edit added to `relFilePath`. Only NEW specifiers (in the
 * new content, not the old) are checked, so a pre-existing unresolved import the
 * model didn't touch is never held against it. Returns the unresolved additions
 * plus the declared-dep list for the feedback message. I/O: reads package.json
 * and resolves via the filesystem.
 */
export async function checkNewImports(
  oldSource: string,
  newSource: string,
  relFilePath: string,
  repoRoot: string,
): Promise<ImportCheckResult> {
  const added = diffNewSpecifiers(oldSource, newSource);
  if (added.length === 0) return { unresolved: [], availableDeps: [] };
  const declaredDeps = await readDeclaredDeps(repoRoot);
  const absFile = path.isAbsolute(relFilePath) ? relFilePath : path.resolve(repoRoot, relFilePath);
  const unresolved = added.filter((spec) => !resolveSpecifier(spec, absFile, repoRoot, declaredDeps));
  return { unresolved, availableDeps: [...declaredDeps].sort() };
}

/**
 * Build the model-facing rejection message for a set of unresolved imports.
 * Names the offending specifiers and the deps that DO exist, and tells the model
 * to use a relative import or a listed dependency — the actionable signal a raw
 * "Cannot find module" lacks. Pure.
 */
export function formatImportRejection(relFilePath: string, result: ImportCheckResult): string {
  const bad = result.unresolved.map((s) => `\`${s}\``).join(", ");
  const deps =
    result.availableDeps.length > 0
      ? result.availableDeps.map((d) => `\`${d}\``).join(", ")
      : "(none declared — use built-in Node/Bun modules or a relative import)";
  return (
    `IMPORT ERROR — your edit to \`${relFilePath}\` imports ${bad}, which does not resolve ` +
    `(no such file, and not a declared dependency). Do NOT invent modules. ` +
    `This repo's dependencies are: ${deps}. Use one of those, a Node/Bun builtin ` +
    `(e.g. \`node:path\`), or a relative import to a file that exists.`
  );
}
