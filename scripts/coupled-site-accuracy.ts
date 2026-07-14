// Model-free coupled-decl accuracy measuring stick.
//
// Measures whether surfaceCoupledDecls (src/context/coupled-decls.ts) recovers
// the MODULE-LEVEL declarations a genuine coupled two-site bug-fix needs,
// beyond what today's pipeline (buildContext -> targetFile function only)
// already surfaces. Read-only: runs the real walkRepo/buildContext pipeline
// against the BUGGY fixture, diffs buggy vs solution fixture text to derive
// ground truth, and reports recall/precision. Does not write to
// evals/metrics-history.jsonl or evals/transcripts.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildContext } from "@/context/builder.ts";
import { surfaceCoupledDecls } from "@/context/coupled-decls.ts";
import { extractSymbols } from "@/context/extractor.ts";
import { walkRepo } from "@/context/walker.ts";

const ROOT = ".";
const SUITES = ["coupled-site"];
const TOKEN_BUDGET = 28672;

function languageForPath(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return "javascript";
  }
  return "unknown";
}

/** Matches a top-level (non-indented) const/let/var binding declaration. */
const TOP_LEVEL_DECL_RE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const MAX_BALANCE_SCAN_LINES = 5000;

/** Best-effort end-line via brace/paren/bracket balance (mirrors coupled-decls.ts). */
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
    if (sawOpener && balance <= 0) return i + 1;
  }
  return sawOpener ? limit : startIdx + 1;
}

interface TopLevelDecl {
  name: string;
  text: string;
}

/** Parse all top-level const/let/var decls in `content` -> name + full decl text. */
function parseTopLevelDecls(content: string): Map<string, TopLevelDecl> {
  const lines = content.split("\n");
  const out = new Map<string, TopLevelDecl>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = TOP_LEVEL_DECL_RE.exec(line);
    if (!m?.[1]) continue;
    const name = m[1];
    const endLine = findDeclEndLine(lines, i);
    const text = lines.slice(i, endLine).join("\n");
    out.set(name, { name, text });
  }
  return out;
}

function fmtList(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "(none)";
}

interface Row {
  id: string;
  pickedOk: boolean;
  targetFn: string | undefined;
  gtNames: string[];
  inFnSecondSite: string; // "yes" | "no" | "n/a"
  baselineRecall: number | undefined;
  walkerRecall: number | undefined;
  walkerPrecision: number | undefined;
  surfacedNames: string[];
}

const rows: Row[] = [];
// Micro-average accumulators.
let baselineHitSum = 0;
let walkerHitSum = 0;
let gtSizeSum = 0;
const precisionSamples: number[] = [];

for (const suite of SUITES) {
  const suiteDir = join(ROOT, "evals/suites", suite);
  let taskFiles: string[];
  try {
    taskFiles = (await readdir(suiteDir)).filter((f) => f.endsWith(".json"));
  } catch {
    continue;
  }
  taskFiles.sort();

  for (const tf of taskFiles) {
    const task = JSON.parse(await Bun.file(join(suiteDir, tf)).text());
    const fixture = task?.setup?.repoFixture;
    const solutionRel = task?.reference_solution;
    if (!fixture || !solutionRel) continue;

    const fixtureDir = join(ROOT, "evals/fixtures", fixture);
    const solutionDir = join(ROOT, "evals/fixtures", solutionRel.replace(/\/$/, ""));

    let repoMap;
    try {
      repoMap = await walkRepo({ root: fixtureDir }, 0);
    } catch {
      rows.push({
        id: task.id,
        pickedOk: false,
        targetFn: undefined,
        gtNames: [],
        inFnSecondSite: "n/a",
        baselineRecall: undefined,
        walkerRecall: undefined,
        walkerPrecision: undefined,
        surfacedNames: [],
      });
      continue;
    }

    const bundle = await buildContext(repoMap, task.desc, { repoRoot: fixtureDir, tokenBudget: TOKEN_BUDGET });
    const targetFile = bundle.targetFile;
    const pickedOk = targetFile !== undefined && targetFile.functionName !== undefined;

    if (!pickedOk) {
      rows.push({
        id: task.id,
        pickedOk: false,
        targetFn: targetFile?.functionName,
        gtNames: [],
        inFnSecondSite: "n/a",
        baselineRecall: undefined,
        walkerRecall: undefined,
        walkerPrecision: undefined,
        surfacedNames: [],
      });
      continue;
    }

    const path = targetFile!.path;
    const functionName = targetFile!.functionName!;
    const functionStartLine = targetFile!.functionStartLine;
    const functionEndLine = targetFile!.functionEndLine;

    const buggyContent = await Bun.file(join(fixtureDir, path)).text();
    const solutionContent = await Bun.file(join(solutionDir, path)).text();
    const language = languageForPath(path);
    const symbols = extractSymbols(path, buggyContent, language);

    // Walker's surfaced set.
    const surfaced = surfaceCoupledDecls(buggyContent, symbols, functionName);
    const surfacedNames = surfaced.map((d) => d.name);

    // Ground truth: top-level decls present in both buggy+solution whose full
    // decl TEXT differs.
    const buggyDecls = parseTopLevelDecls(buggyContent);
    const solutionDecls = parseTopLevelDecls(solutionContent);
    const gtNames: string[] = [];
    // Also need line numbers in the BUGGY file for the baseline-recall check.
    const buggyLines = buggyContent.split("\n");
    const gtLines = new Map<string, number>();
    for (let i = 0; i < buggyLines.length; i++) {
      const line = buggyLines[i] ?? "";
      const m = TOP_LEVEL_DECL_RE.exec(line);
      if (m?.[1]) gtLines.set(m[1], i + 1);
    }
    for (const [name, buggyDecl] of buggyDecls) {
      const solDecl = solutionDecls.get(name);
      if (solDecl && solDecl.text !== buggyDecl.text) {
        gtNames.push(name);
      }
    }

    // In-fn 2nd site fyi flag: does the target fn's body differ buggy vs solution?
    const solutionSymbols = extractSymbols(path, solutionContent, language);
    const solutionFn = solutionSymbols.find(
      (s) => s.name === functionName && (s.kind === "function" || s.kind === "method"),
    );
    let inFnSecondSite = "n/a";
    if (functionStartLine !== undefined && functionEndLine !== undefined && solutionFn) {
      const buggyBody = buggyLines.slice(functionStartLine - 1, functionEndLine).join("\n");
      const solutionLines = solutionContent.split("\n");
      const solutionBody = solutionLines.slice(solutionFn.line - 1, solutionFn.endLine).join("\n");
      inFnSecondSite = buggyBody !== solutionBody ? "yes" : "no";
    }

    // Baseline: today's pipeline surfaces nothing beyond the fn range itself.
    // Credit a GT decl to baseline only if its line honestly falls inside
    // [functionStartLine, functionEndLine].
    let baselineHits = 0;
    if (functionStartLine !== undefined && functionEndLine !== undefined) {
      for (const name of gtNames) {
        const line = gtLines.get(name);
        if (line !== undefined && line >= functionStartLine && line <= functionEndLine) {
          baselineHits += 1;
        }
      }
    }
    const baselineRecall = gtNames.length > 0 ? baselineHits / gtNames.length : undefined;

    // Walker recall/precision (match by name).
    const surfacedSet = new Set(surfacedNames);
    let walkerHits = 0;
    for (const name of gtNames) {
      if (surfacedSet.has(name)) walkerHits += 1;
    }
    const walkerRecall = gtNames.length > 0 ? walkerHits / gtNames.length : undefined;
    const walkerPrecision = surfacedNames.length > 0 ? walkerHits / surfacedNames.length : undefined;

    if (gtNames.length > 0) {
      baselineHitSum += baselineHits;
      walkerHitSum += walkerHits;
      gtSizeSum += gtNames.length;
    }
    if (walkerPrecision !== undefined) precisionSamples.push(walkerPrecision);

    rows.push({
      id: task.id,
      pickedOk: true,
      targetFn: functionName,
      gtNames,
      inFnSecondSite,
      baselineRecall,
      walkerRecall,
      walkerPrecision,
      surfacedNames,
    });
  }
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------
console.log(
  "legend: recall = |surfaced ∩ ground-truth| / |ground-truth| (did we find the coupled decls the fix needs); " +
    "precision = |surfaced ∩ ground-truth| / |surfaced| (how much of what we surfaced was actually needed), N/A if nothing surfaced\n",
);

const header = [
  "task",
  "picked?",
  "targetFn",
  "GT_moduleDecls",
  "in-fn 2nd site",
  "baseline recall",
  "walker recall",
  "walker precision",
  "surfaced",
].join(" | ");
console.log(header);
console.log("-".repeat(header.length));

for (const r of rows) {
  const fmtPct = (v: number | undefined) => (v === undefined ? "n/a" : v.toFixed(2));
  console.log(
    [
      r.id,
      r.pickedOk ? "yes" : "NO",
      r.targetFn ?? "(none)",
      fmtList(r.gtNames),
      r.inFnSecondSite,
      fmtPct(r.baselineRecall),
      fmtPct(r.walkerRecall),
      fmtPct(r.walkerPrecision),
      fmtList(r.surfacedNames),
    ].join(" | "),
  );
}

console.log();
const pooledBaselineRecall = gtSizeSum > 0 ? baselineHitSum / gtSizeSum : undefined;
const pooledWalkerRecall = gtSizeSum > 0 ? walkerHitSum / gtSizeSum : undefined;
const meanPrecision =
  precisionSamples.length > 0
    ? precisionSamples.reduce((a, b) => a + b, 0) / precisionSamples.length
    : undefined;

console.log(
  `pooled (micro-avg) BASELINE recall: ${pooledBaselineRecall === undefined ? "n/a" : pooledBaselineRecall.toFixed(3)} ` +
    `(${baselineHitSum}/${gtSizeSum})`,
);
console.log(
  `pooled (micro-avg) WALKER recall:   ${pooledWalkerRecall === undefined ? "n/a" : pooledWalkerRecall.toFixed(3)} ` +
    `(${walkerHitSum}/${gtSizeSum})`,
);
console.log(
  `mean WALKER precision (over tasks with >=1 surfaced): ${meanPrecision === undefined ? "n/a" : meanPrecision.toFixed(3)} ` +
    `(n=${precisionSamples.length})`,
);
