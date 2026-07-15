#!/usr/bin/env bun
/**
 * audit-operator-mutation.ts — MODEL-FREE fake-green audit for SMALLCODE_MUTATION_REPAIR.
 *
 * Mirrors scripts/audit-literal-repair.ts exactly, for the operator-mutation
 * repair pass instead of the literal-mutation one.
 *
 * SMALLCODE_MUTATION_REPAIR (default ON, src/repair/operator-mutation.ts +
 * src/agent/loop.ts::runOperatorMutationRepair) is a last-resort deterministic
 * pass: brute-force single comparison/logical/arithmetic-operator flips in the
 * locked fix-target file, run the real test oracle after each, keep the FIRST
 * candidate that goes fully green. The risk: on a weak/thin test oracle, an
 * operator flip could green a task via a SEMANTICALLY WRONG change — a
 * different operator flip that happens to satisfy the (thin) test suite but is
 * not the intended fix ("fake-green"). This script audits the whole
 * solution-backed eval-fixture corpus for that risk, reusing the real
 * enumerator so the candidate set/order matches exactly what the harness pass
 * would try.
 *
 * Scoping — matches PRODUCTION, not worst-case:
 * runOperatorMutationRepair (src/agent/loop.ts) operates on ONLY the single
 * `state.lockedTargetPath` file (NOT the multi-file editable set the model
 * loop may otherwise use), then narrows further via `scopeMutationsToRange` to
 * the locked target FUNCTION's line range when `state.lockedTargetRange` is
 * known. That range comes from the live planner's `pickTargetFunction` call
 * during a real agent run and is not cheaply reproducible standalone for an
 * arbitrary fixture without re-running the planner — `scopeMutationsToRange`
 * itself documents that an `undefined` range is the correct conservative
 * whole-file fallback in that case (same precedent audit-literal-repair.ts
 * already relies on for its own worst-case framing). So this audit scopes to
 * the SINGLE reference-fix file only (production's real scope), whole-file
 * within that one file (the honest fallback when the function range can't be
 * derived without the planner) — tighter than audit-literal-repair.ts's
 * multi-file worst-case, because operator-mutation repair itself is
 * single-file in production.
 *
 * Model-free: no Ollama, no LLM. Pure fixture-copy + oracle-run against the
 * PRISTINE buggy fixture on disk, in a scratch temp dir. Does not touch src/,
 * existing tasks/fixtures/suite.json, or evals/metrics-history.jsonl.
 *
 * Usage:
 *   bun scripts/audit-operator-mutation.ts
 *   bun scripts/audit-operator-mutation.ts --suites=realrepo,multifile
 */

import { mkdir, cp, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { loadSuite } from "../src/eval/task-loader.ts";
import { runDeterministicGrader } from "../src/eval/graders/deterministic.ts";
import { enumerateComparisonMutations } from "../src/repair/operator-mutation.ts";
import type { GraderConfig, EvalTask } from "../src/eval/types.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const FIXTURES_DIR = join(PROJECT_ROOT, "evals", "fixtures");
const SUITES_DIR = join(PROJECT_ROOT, "evals", "suites");
const SCRATCH_ROOT =
  "/private/tmp/claude-501/-Users-Joshua-Knox-projects-smallcode-claude/4aed2d2d-9c76-4f35-adfb-92e651df582e/scratchpad";
const TMP_BASE = join(SCRATCH_ROOT, "audit-operator-mutation-tmp");

const SUITE_NAMES =
  process.argv.find((a) => a.startsWith("--suites="))?.slice("--suites=".length).split(",") ?? [
    "realrepo",
    "edit-reliability",
    "multifile",
  ];

// ---------------------------------------------------------------------------
// Grader helper — identical to audit-literal-repair.ts's runGraders.
// ---------------------------------------------------------------------------

async function runGraders(graders: GraderConfig[], trialDir: string): Promise<boolean> {
  const results = await Promise.all(
    graders.map((g) => {
      if (g.type === "deterministic_tests") return runDeterministicGrader(g, trialDir);
      // Non-deterministic graders are out of scope for this audit (operator
      // mutation repair only ever runs against deterministic_tests in
      // practice, since that's the real oracle it uses); treat as pass so it
      // never blocks.
      return Promise.resolve({ type: g.type, verdict: "pass" as const, score: 1, output: "", durationMs: 0 });
    }),
  );
  return results.every((r) => r.verdict === "pass");
}

async function layBase(trialDir: string, repoFixture: string) {
  await rm(trialDir, { recursive: true, force: true });
  await mkdir(trialDir, { recursive: true });
  await cp(join(FIXTURES_DIR, repoFixture), trialDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Reference-fix classification heuristic
//
// For each changed line (buggy vs solution, same file), strip every operator
// token the real enumerator recognizes (OP_RE semantics inlined here, since
// it's not exported) from both sides and compare the remainder. If the
// remainder is identical for every changed line in the file, the reference
// fix only ever touched OPERATOR tokens (identifiers/literals/strings/
// structure untouched) -> "operator-only". Otherwise ("non-operator") the fix
// changed something the enumerator could never reproduce by flipping a single
// operator.
//
// Line-based diff (naive same-index alignment), same honesty tradeoff as
// audit-literal-repair.ts: adequate for this corpus's small tightly-scoped
// reference solutions; a line insertion/deletion is caught separately via
// `lineCountChanged`.
// ---------------------------------------------------------------------------

// Same token set/precedence as src/repair/operator-mutation.ts's OP_RE + SKIP,
// duplicated here (not exported) so we can strip operator tokens from a line
// the same way the enumerator recognizes them, longest-first so multi-char
// tokens win over their single-char pieces.
const OP_RE = /===|!==|==|!=|<=|>=|<<|>>|=>|&&|\|\||\+\+|--|\+=|-=|\+|-|<|>/g;
const SKIP = new Set(["<<", ">>", "=>", "++", "--", "+=", "-="]);
const MUTABLE_OPS = new Set(["===", "!==", "==", "!=", "<", ">", "<=", ">=", "&&", "||", "+", "-"]);

function stripOperators(line: string): string {
  return line.replace(OP_RE, (tok) => (SKIP.has(tok) ? tok : " "));
}

function extractOperators(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(OP_RE)) {
    const tok = m[0];
    if (SKIP.has(tok)) continue;
    if (MUTABLE_OPS.has(tok)) out.push(tok);
  }
  return out;
}

interface LineDiff {
  lineNo: number; // 1-based
  buggy: string;
  solution: string;
  operatorOnly: boolean;
  buggyOperators: string[];
  solutionOperators: string[];
}

interface FileClassification {
  file: string;
  changedLines: LineDiff[];
  lineCountChanged: boolean; // file grew/shrank -> can't be operator-only
  classification: "operator-only" | "non-operator";
}

function classifyFileDiff(buggySrc: string, solutionSrc: string, file: string): FileClassification {
  const buggyLines = buggySrc.split("\n");
  const solutionLines = solutionSrc.split("\n");
  const lineCountChanged = buggyLines.length !== solutionLines.length;

  const changedLines: LineDiff[] = [];
  const maxLen = Math.max(buggyLines.length, solutionLines.length);
  for (let i = 0; i < maxLen; i++) {
    const b = buggyLines[i] ?? "";
    const s = solutionLines[i] ?? "";
    if (b === s) continue;
    const bStripped = stripOperators(b);
    const sStripped = stripOperators(s);
    const operatorOnly = bStripped === sStripped;
    const buggyOperators = extractOperators(b);
    const solutionOperators = extractOperators(s);
    changedLines.push({ lineNo: i + 1, buggy: b, solution: s, operatorOnly, buggyOperators, solutionOperators });
  }

  const classification: "operator-only" | "non-operator" =
    !lineCountChanged && changedLines.length > 0 && changedLines.every((l) => l.operatorOnly)
      ? "operator-only"
      : "non-operator";

  return { file, changedLines, lineCountChanged, classification };
}

// ---------------------------------------------------------------------------
// Task audit
// ---------------------------------------------------------------------------

type TaskVerdict = "no-green" | "true-fix" | "FAKE-GREEN";

interface TaskAuditResult {
  suite: string;
  taskId: string;
  verdict: TaskVerdict;
  detail: string;
  greenFile?: string;
  greenLabel?: string;
  candidatesTried: number;
}

/**
 * Production scope: operator-mutation repair only ever touches the single
 * locked target file (see runOperatorMutationRepair in src/agent/loop.ts —
 * `state.lockedTargetPath`, never the wider multi-file editable set). For a
 * solution-backed audit task the closest honest stand-in for "the locked
 * target file" is the file the reference solution actually changed: if the
 * solution overlay touches exactly one changed source file, that IS what the
 * planner would have locked onto for this bug. If it touches more than one,
 * operator-mutation repair (single-file in production) could never have
 * fixed it via this pass regardless of enumeration — record it as
 * "no-green" (not reachable) since a real run's single-file repair pass could
 * never even attempt the second file's fix. This keeps the audit's exposure
 * surface equal to (not wider than) what production really tries per task.
 */
async function auditTask(suite: string, task: EvalTask): Promise<TaskAuditResult | null> {
  const refSol = task.referenceSolution;
  const repoFixture = task.setup.repoFixture;
  if (!refSol || !repoFixture) return null;

  const solutionDir = join(FIXTURES_DIR, refSol.replace(/\/$/, ""));
  const buggyDir = join(FIXTURES_DIR, repoFixture);

  // 1. Find every source file the solution overlay touches, classify each.
  const solutionFiles = await listSourceFiles(solutionDir);
  const fileClassifications: FileClassification[] = [];
  for (const solAbs of solutionFiles) {
    const rel = relative(solutionDir, solAbs);
    const buggyAbs = join(buggyDir, rel);
    const buggyExists = await Bun.file(buggyAbs).exists();
    if (!buggyExists) continue; // solution adds a new file entirely -> definitely non-operator, but nothing to mutate
    const buggySrc = await Bun.file(buggyAbs).text();
    const solutionSrc = await Bun.file(solAbs).text();
    if (buggySrc === solutionSrc) continue; // untouched despite being in overlay dir
    fileClassifications.push(classifyFileDiff(buggySrc, solutionSrc, rel));
  }

  const overallRefClass: "operator-only" | "non-operator" =
    fileClassifications.length > 0 && fileClassifications.every((f) => f.classification === "operator-only")
      ? "operator-only"
      : "non-operator";

  // 2. PRODUCTION scope: single locked-target file only. Stand-in for the
  // locked target = the (sole) file the reference solution changed. If the
  // solution touched >1 file, single-file repair could never reach the real
  // fix regardless — no candidates are tried (matches what a real run's
  // single-file pass would do: it locks one file and never sees the other).
  const filesToScan = fileClassifications.length === 1 ? fileClassifications.map((f) => f.file) : [];

  const trialDir = join(TMP_BASE, `${suite}--${task.id}`);
  let candidatesTried = 0;
  let firstGreen: { file: string; label: string; line: number } | null = null;

  outer: for (const relFile of filesToScan) {
    const buggyAbs = join(buggyDir, relFile);
    const buggySrc = await Bun.file(buggyAbs).text();
    const { mutations } = enumerateComparisonMutations(buggySrc, 60);
    for (const mut of mutations) {
      candidatesTried++;
      await layBase(trialDir, repoFixture);
      await Bun.write(join(trialDir, relFile), mut.candidate);
      const green = await runGraders(task.graders, trialDir);
      if (green) {
        firstGreen = { file: relFile, label: mut.label, line: mut.line };
        break outer;
      }
    }
  }
  await rm(trialDir, { recursive: true, force: true });

  if (!firstGreen) {
    const scopeNote =
      fileClassifications.length > 1
        ? ` (reference solution spans ${fileClassifications.length} files — outside single-file repair's production scope, 0 candidates tried)`
        : "";
    return {
      suite,
      taskId: task.id,
      verdict: "no-green",
      detail: `scanned ${filesToScan.length} file(s), ${candidatesTried} candidates, none greened${scopeNote}`,
      candidatesTried,
    };
  }

  // 3. Decide true-fix vs FAKE-GREEN.
  const fc = fileClassifications.find((f) => f.file === firstGreen!.file);
  let isTrueFix = false;
  let detail: string;
  if (overallRefClass === "operator-only" && fc && fc.classification === "operator-only") {
    // Does the greening mutation reproduce the reference operator change on
    // ITS changed line(s) in this file? True-fix requires the SAME line, the
    // SAME original operator, and the SAME target operator as the reference.
    const matchesRef = fc.changedLines.some(
      (l) =>
        l.lineNo === firstGreen!.line &&
        l.buggyOperators.length === 1 &&
        l.solutionOperators.length === 1 &&
        `${l.buggyOperators[0]} -> ${l.solutionOperators[0]}` === firstGreen!.label,
    );
    isTrueFix = matchesRef;
    detail = matchesRef
      ? `mutation matches reference operator change in ${firstGreen.file} @L${firstGreen.line}`
      : `reference is operator-only but greening flip (${firstGreen.label} @L${firstGreen.line}) does not match the reference's operator change`;
  } else {
    detail = `reference fix for ${firstGreen.file} is ${fc?.classification ?? "non-operator"} (not an operator-only change): ${
      fc?.changedLines
        .slice(0, 2)
        .map((l) => `L${l.lineNo} "${l.buggy.trim()}" -> "${l.solution.trim()}"`)
        .join(" | ") ?? "solution adds/removes lines"
    }`;
  }

  return {
    suite,
    taskId: task.id,
    verdict: isTrueFix ? "true-fix" : "FAKE-GREEN",
    detail,
    greenFile: firstGreen.file,
    greenLabel: `${firstGreen.label} @L${firstGreen.line}`,
    candidatesTried,
  };
}

import { readdir } from "node:fs/promises";

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        await walk(full);
      } else if (/\.(js|jsx|ts|tsx)$/.test(e.name) && !/\.test\.[tj]sx?$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(TMP_BASE, { recursive: true });

  const allResults: TaskAuditResult[] = [];
  const skippedSuites: string[] = [];

  for (const suiteName of SUITE_NAMES) {
    const suiteDir = join(SUITES_DIR, suiteName);
    let suite;
    try {
      suite = await loadSuite(suiteDir);
    } catch (err) {
      console.error(`[audit] SKIP suite "${suiteName}": failed to load — ${err instanceof Error ? err.message : String(err)}`);
      skippedSuites.push(suiteName);
      continue;
    }

    const solutionBacked = suite.tasks.filter((t) => t.referenceSolution && t.setup.repoFixture);
    console.log(`\n[audit] suite "${suiteName}": ${suite.tasks.length} tasks, ${solutionBacked.length} solution-backed`);

    for (const task of solutionBacked) {
      process.stdout.write(`[audit]   ${task.id} ... `);
      try {
        const result = await auditTask(suiteName, task);
        if (result) {
          allResults.push(result);
          console.log(`${result.verdict} (${result.candidatesTried} candidates tried)`);
        } else {
          console.log("SKIP (missing repoFixture/referenceSolution)");
        }
      } catch (err) {
        console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  await rm(TMP_BASE, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------

  console.log("\n\n==================== AUDIT REPORT ====================\n");

  if (skippedSuites.length > 0) {
    console.log(`Skipped suites (failed to load): ${skippedSuites.join(", ")}\n`);
  }

  const bySuite = new Map<string, TaskAuditResult[]>();
  for (const r of allResults) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
    bySuite.get(r.suite)!.push(r);
  }

  console.log("suite               | scanned | no-green | true-fix | FAKE-GREEN");
  console.log("--------------------+---------+----------+----------+-----------");
  let totScanned = 0, totNoGreen = 0, totTrueFix = 0, totFake = 0;
  for (const [suite, results] of bySuite) {
    const noGreen = results.filter((r) => r.verdict === "no-green").length;
    const trueFix = results.filter((r) => r.verdict === "true-fix").length;
    const fake = results.filter((r) => r.verdict === "FAKE-GREEN").length;
    totScanned += results.length; totNoGreen += noGreen; totTrueFix += trueFix; totFake += fake;
    console.log(
      `${suite.padEnd(20)} | ${String(results.length).padEnd(7)} | ${String(noGreen).padEnd(8)} | ${String(trueFix).padEnd(8)} | ${fake}`,
    );
  }
  console.log("--------------------+---------+----------+----------+-----------");
  console.log(`${"TOTAL".padEnd(20)} | ${String(totScanned).padEnd(7)} | ${String(totNoGreen).padEnd(8)} | ${String(totTrueFix).padEnd(8)} | ${totFake}`);

  const fakeGreens = allResults.filter((r) => r.verdict === "FAKE-GREEN");
  if (fakeGreens.length > 0) {
    console.log("\nFAKE-GREEN detail:");
    for (const r of fakeGreens) {
      console.log(`  - [${r.suite}] ${r.taskId}: ${r.greenLabel} in ${r.greenFile}`);
      console.log(`      why suspicious: ${r.detail}`);
    }
  }

  console.log("\n---------------------------------------------------------\n");
  if (totFake === 0) {
    console.log("Bottom line: 0 FAKE-GREEN across the audited corpus.");
    console.log("Disposition: safe to keep SMALLCODE_MUTATION_REPAIR default ON.");
  } else {
    const fakeRate = totFake / totScanned;
    console.log(`Bottom line: ${totFake}/${totScanned} (${(fakeRate * 100).toFixed(1)}%) FAKE-GREEN task(s) found — the pass can accept a wrong fix on a thin oracle.`);
    console.log("Compare to the literal-repair audit's 4/38 = 10.5% fake-green rate (which led to keeping SMALLCODE_LITERAL_REPAIR default OFF).");
    console.log(
      "Tightening check: fn-range scoping (scopeMutationsToRange, applied in production when state.lockedTargetRange\n" +
      "is known) would only help if every FAKE-GREEN mutation landed OUTSIDE the locked target function's range —\n" +
      "inspect the FAKE-GREEN file/line list above against each task's target function to judge whether that scope\n" +
      "tightening (already live in production, just not reproducible standalone here) would have excluded the\n" +
      "offending candidate.",
    );
  }
  console.log("");
}

main().catch((err: unknown) => {
  console.error("[audit-operator-mutation] FATAL:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
