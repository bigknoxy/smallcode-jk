#!/usr/bin/env bun
/**
 * Transcript triage tool — reads all *.json eval run results from
 * evals/transcripts/ and auto-categorizes failures into buckets:
 *
 *   model_error    — model reasoned wrong (max_turns reached, or all turns
 *                    produced answers but tests still fail)
 *   scaffold_bug   — edit protocol choked (all applyResults failed, or
 *                    think-only completion: answer empty, reasoning non-empty)
 *   grader_bug     — grader rejected a valid solution
 *   ambiguous_task — task description is vague (mixed partial/fail across trials)
 *
 * Usage:
 *   bun scripts/triage-transcripts.ts [runId]
 *
 * Writes triage summary to evals/triage-<runId>.json
 * Exits 0 always (this is a report, not a gate).
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import type { EvalRunResult, TrialResult } from "../src/eval/types.ts";
import type { TurnRecord } from "../src/agent/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const TRANSCRIPTS_DIR = join(PROJECT_ROOT, "evals", "transcripts");
const EVALS_DIR = join(PROJECT_ROOT, "evals");

// ---------------------------------------------------------------------------
// Triage types
// ---------------------------------------------------------------------------

type TriageBucket = "model_error" | "scaffold_bug" | "grader_bug" | "ambiguous_task";

interface TriageEntry {
  taskId: string;
  trialIndex: number;
  bucket: TriageBucket;
  reason: string;
}

interface TriageSummary {
  runId: string;
  totalFailed: number;
  byBucket: Record<TriageBucket, number>;
  failures: TriageEntry[];
}

// ---------------------------------------------------------------------------
// Bucket detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect scaffold_bug: all applyResults failed in at least one turn,
 * OR think-only completion (answer empty, reasoning non-empty).
 */
function detectScaffoldBug(turns: TurnRecord[]): string | null {
  for (const turn of turns) {
    // Think-only completion: model only produced reasoning, no answer
    if (turn.answer.trim() === "" && turn.reasoning && turn.reasoning.trim().length > 0) {
      return `think-only completion on turn ${turn.turn} (answer empty, reasoning present)`;
    }

    // All applyResults failed in a turn that had apply attempts
    if (turn.applyResults.length > 0) {
      const allFailed = turn.applyResults.every(
        (r) => r.status !== "applied",
      );
      if (allFailed) {
        const statuses = turn.applyResults.map((r) => r.status).join(", ");
        return `all ${turn.applyResults.length} applyResult(s) failed on turn ${turn.turn} (statuses: ${statuses})`;
      }
    }
  }
  return null;
}

/**
 * Detect model_error: agent reached max_turns OR all turns had non-empty
 * answers but the trial still failed (model answered but got it wrong).
 */
function detectModelError(
  trial: TrialResult,
  transcript: { outcome: string; turns: TurnRecord[] },
): string | null {
  // Reached max turns
  if (transcript.outcome === "timeout" || transcript.outcome === "error") {
    if (transcript.outcome === "timeout") {
      return "agent reached max_turns (timeout)";
    }
  }

  // Check if the transcript outcome indicates max_turns
  if (transcript.outcome === "error" && trial.error?.includes("max_turns")) {
    return "agent reached max_turns";
  }

  // All turns had non-empty answers but still failed
  if (transcript.turns.length > 0) {
    const allHadAnswers = transcript.turns.every((t) => t.answer.trim().length > 0);
    if (allHadAnswers) {
      return `model produced answers on all ${transcript.turns.length} turns but graders still failed`;
    }
  }

  return null;
}

/**
 * Detect ambiguous_task: among all trials for this task, some partially
 * passed and some failed entirely — indicating the task description may be
 * unclear.
 */
function detectAmbiguousTask(
  taskId: string,
  allTrials: TrialResult[],
): string | null {
  const taskTrials = allTrials.filter((t) => t.taskId === taskId);
  if (taskTrials.length < 2) return null;

  const hasPartial = taskTrials.some((t) => !t.passed && t.partialScore > 0 && t.partialScore < 1);
  const hasFullFail = taskTrials.some((t) => !t.passed && t.partialScore === 0);

  if (hasPartial && hasFullFail) {
    const scores = taskTrials.map((t) => t.partialScore.toFixed(2)).join(", ");
    return `trials disagree on approach — partial scores: [${scores}]`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main triage logic for a single trial
// ---------------------------------------------------------------------------

function triageTrial(
  trial: TrialResult,
  allTrials: TrialResult[],
): TriageEntry {
  const { taskId, trialIndex, transcript } = trial;
  const turns = transcript.turns;

  // 1. Check scaffold_bug first (most specific signal)
  const scaffoldReason = detectScaffoldBug(turns);
  if (scaffoldReason !== null) {
    return {
      taskId,
      trialIndex,
      bucket: "scaffold_bug",
      reason: scaffoldReason,
    };
  }

  // 2. Check ambiguous_task (requires cross-trial view)
  const ambiguousReason = detectAmbiguousTask(taskId, allTrials);
  if (ambiguousReason !== null) {
    return {
      taskId,
      trialIndex,
      bucket: "ambiguous_task",
      reason: ambiguousReason,
    };
  }

  // 3. Check model_error
  const modelErrorReason = detectModelError(trial, transcript);
  if (modelErrorReason !== null) {
    return {
      taskId,
      trialIndex,
      bucket: "model_error",
      reason: modelErrorReason,
    };
  }

  // 4. Default: grader_bug (grader may have rejected a valid solution)
  // We can't run graders here without the fixture, so we mark as grader_bug
  // when no other signal fires and the trial has partial score > 0 (some graders passed)
  const hasPartialPass = trial.partialScore > 0 && trial.partialScore < 1;
  if (hasPartialPass) {
    const failedGraders = trial.graderResults
      .filter((g) => g.verdict !== "pass")
      .map((g) => `${g.type}=${g.verdict}`)
      .join(", ");
    return {
      taskId,
      trialIndex,
      bucket: "grader_bug",
      reason: `partial score ${trial.partialScore.toFixed(2)} — failed graders: [${failedGraders}]`,
    };
  }

  // 5. Fall through to model_error as default
  return {
    taskId,
    trialIndex,
    bucket: "model_error",
    reason: trial.error ?? "trial failed with no specific signal detected",
  };
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

async function findTranscriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const jsonFiles: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      jsonFiles.push(join(dir, entry.name));
    }
  }

  return jsonFiles;
}

// ---------------------------------------------------------------------------
// Triage a single run result file
// ---------------------------------------------------------------------------

async function triageRunFile(filePath: string): Promise<TriageSummary | null> {
  const runResult = await readJsonFile<EvalRunResult>(filePath);
  if (runResult === null) {
    console.warn(`  [warn] Could not parse: ${filePath}`);
    return null;
  }

  // Collect all trial results from all tasks
  const allTrials: TrialResult[] = runResult.taskResults.flatMap((tr) => tr.trials);

  // Find failed trials
  const failedTrials = allTrials.filter((t) => !t.passed);

  const failures: TriageEntry[] = [];
  for (const trial of failedTrials) {
    const entry = triageTrial(trial, allTrials);
    failures.push(entry);

    // Print triage line
    console.log(`  ${entry.taskId} trial-${entry.trialIndex}: [${entry.bucket}] — ${entry.reason}`);
  }

  const byBucket: Record<TriageBucket, number> = {
    model_error: 0,
    scaffold_bug: 0,
    grader_bug: 0,
    ambiguous_task: 0,
  };

  for (const f of failures) {
    byBucket[f.bucket]++;
  }

  return {
    runId: runResult.runId,
    totalFailed: failedTrials.length,
    byBucket,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const targetRunId = process.argv[2]; // optional

  console.log("[triage-transcripts] Scanning evals/transcripts/ ...");

  let files: string[];
  try {
    files = await findTranscriptFiles(TRANSCRIPTS_DIR);
  } catch {
    console.log("[triage-transcripts] No transcripts directory found. Nothing to triage.");
    process.exit(0);
  }

  if (files.length === 0) {
    console.log("[triage-transcripts] No transcript JSON files found in evals/transcripts/.");
    console.log(
      "[triage-transcripts] Run the eval harness first to generate transcripts, then re-run this script.",
    );
    process.exit(0);
  }

  // Filter by runId if provided
  const filesToProcess = targetRunId
    ? files.filter((f) => basename(f, ".json") === targetRunId || f.includes(targetRunId))
    : files;

  if (filesToProcess.length === 0) {
    console.log(`[triage-transcripts] No transcripts found matching runId: ${targetRunId}`);
    process.exit(0);
  }

  console.log(`[triage-transcripts] Processing ${filesToProcess.length} file(s)...\n`);

  await mkdir(EVALS_DIR, { recursive: true });

  let totalProcessed = 0;
  let totalFailed = 0;

  for (const filePath of filesToProcess) {
    const runId = basename(filePath, ".json");
    console.log(`--- Run: ${runId} ---`);

    const summary = await triageRunFile(filePath);
    if (summary === null) continue;

    totalProcessed++;
    totalFailed += summary.totalFailed;

    if (summary.totalFailed === 0) {
      console.log("  (no failures — all trials passed)\n");
      continue;
    }

    // Write triage summary
    const outPath = join(EVALS_DIR, `triage-${summary.runId}.json`);
    await writeFile(outPath, JSON.stringify(summary, null, 2), "utf-8");
    console.log(`\n  Summary: ${summary.totalFailed} failures`);
    console.log(
      `    model_error:    ${summary.byBucket.model_error}`,
    );
    console.log(
      `    scaffold_bug:   ${summary.byBucket.scaffold_bug}`,
    );
    console.log(
      `    grader_bug:     ${summary.byBucket.grader_bug}`,
    );
    console.log(
      `    ambiguous_task: ${summary.byBucket.ambiguous_task}`,
    );
    console.log(`  Triage written to: ${outPath}\n`);
  }

  console.log(
    `[triage-transcripts] Done. Processed ${totalProcessed} run(s), ${totalFailed} total failures.`,
  );
}

main().catch((err: unknown) => {
  console.error(
    "[triage-transcripts] ERROR:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
