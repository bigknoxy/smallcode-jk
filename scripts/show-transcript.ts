#!/usr/bin/env bun
/**
 * Transcript viewer — reads eval run transcripts and displays them.
 *
 * Usage:
 *   bun scripts/show-transcript.ts <runId> [taskId]
 *
 * If taskId is given:
 *   Shows all turns for that task's trials (rawResponse truncated to 500 chars,
 *   reasoning truncated to 200 chars).
 *
 * If no taskId:
 *   Shows a summary table of all tasks with pass/fail counts.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EvalRunResult, TrialResult } from "../src/eval/types.ts";
import type { TurnRecord } from "../src/agent/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const TRANSCRIPTS_DIR = join(PROJECT_ROOT, "evals", "transcripts");

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function trunc(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}... [truncated ${s.length - maxLen} chars]`;
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padStart(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Summary view
// ---------------------------------------------------------------------------

function printSummary(runResult: EvalRunResult): void {
  const COL1 = 36;
  const COL2 = 8;
  const COL3 = 8;
  const COL4 = 10;
  const COL5 = 8;

  const sep = `${"-".repeat(COL1)}-+-${"-".repeat(COL2)}-+-${"-".repeat(COL3)}-+-${"-".repeat(COL4)}-+-${"-".repeat(COL5)}`;

  console.log(`\nRun ID:  ${runResult.runId}`);
  console.log(`Suite:   ${runResult.suiteId}`);
  console.log(`Model:   ${runResult.modelId}`);
  console.log(`Overall: pass@1=${runResult.overallPassAt1.toFixed(3)}, ` +
    `tasks passed=${runResult.totalTasksPassed}/${runResult.taskResults.length}`);
  console.log(
    `\n${padEnd("task-id", COL1)} | ${padEnd("pass", COL2)} | ${padEnd("fail", COL3)} | ${padEnd("pass@1", COL4)} | ${"partial"}`,
  );
  console.log(sep);

  for (const taskResult of runResult.taskResults) {
    const passCount = taskResult.trials.filter((t) => t.passed).length;
    const failCount = taskResult.trials.filter((t) => !t.passed).length;
    const avgPartial = taskResult.avgPartialScore.toFixed(2);

    console.log(
      `${padEnd(taskResult.task.id, COL1)} | ${padStart(String(passCount), COL2)} | ${padStart(String(failCount), COL3)} | ${padEnd(taskResult.passAt1.toFixed(3), COL4)} | ${avgPartial}`,
    );
  }

  console.log(sep);
}

// ---------------------------------------------------------------------------
// Turn detail view
// ---------------------------------------------------------------------------

function printTurn(turn: TurnRecord, trialIndex: number): void {
  console.log(`\n  -- Turn ${turn.turn} (trial ${trialIndex}) --`);

  if (turn.reasoning) {
    console.log(`  reasoning:    ${trunc(turn.reasoning, 200)}`);
  }

  console.log(`  rawResponse:  ${trunc(turn.rawResponse, 500)}`);
  console.log(`  answer:       ${trunc(turn.answer, 200)}`);

  if (turn.toolCalls.length > 0) {
    console.log(`  toolCalls:    ${turn.toolCalls.map((tc) => tc.name).join(", ")}`);
  }

  if (turn.applyResults.length > 0) {
    const results = turn.applyResults
      .map((r) => `${r.filePath}:${r.status}`)
      .join(", ");
    console.log(`  applyResults: ${results}`);
  }

  const tokens = turn.promptTokens + turn.completionTokens;
  console.log(`  tokens:       ${tokens} (prompt=${turn.promptTokens}, completion=${turn.completionTokens})`);
}

function printTaskDetail(taskId: string, trials: TrialResult[]): void {
  const taskTrials = trials.filter((t) => t.taskId === taskId);

  if (taskTrials.length === 0) {
    console.log(`[show-transcript] No trials found for task: ${taskId}`);
    return;
  }

  console.log(`\nTask: ${taskId}`);
  console.log(`Trials: ${taskTrials.length}`);

  for (const trial of taskTrials) {
    const outcome = trial.passed ? "PASS" : "FAIL";
    const duration = formatDuration(trial.metrics.latencyMs);
    console.log(`\n=== Trial ${trial.trialIndex}: ${outcome} (score=${trial.partialScore.toFixed(2)}, ${duration}) ===`);

    if (trial.error) {
      console.log(`  error: ${trial.error}`);
    }

    if (trial.graderResults.length > 0) {
      console.log(`  graders:`);
      for (const gr of trial.graderResults) {
        console.log(`    ${gr.type}: ${gr.verdict} (score=${gr.score.toFixed(2)})`);
        if (gr.verdict !== "pass") {
          console.log(`      output: ${trunc(gr.output, 300)}`);
        }
      }
    }

    console.log(`  turns: ${trial.transcript.turns.length}`);
    for (const turn of trial.transcript.turns) {
      printTurn(turn, trial.trialIndex);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: bun scripts/show-transcript.ts <runId> [taskId]");
    process.exit(1);
  }

  const runId = args[0] as string;
  const taskId = args[1];

  const transcriptPath = join(TRANSCRIPTS_DIR, `${runId}.json`);

  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf-8");
  } catch {
    console.error(`[show-transcript] Could not read transcript: ${transcriptPath}`);
    console.error(`[show-transcript] Available files:`);
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(TRANSCRIPTS_DIR);
      for (const entry of entries) {
        console.error(`  ${entry}`);
      }
    } catch {
      console.error("  (transcripts directory not found or empty)");
    }
    process.exit(1);
  }

  let runResult: EvalRunResult;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid JSON structure");
    }
    runResult = parsed as EvalRunResult;
  } catch (err) {
    console.error(`[show-transcript] Failed to parse transcript: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Collect all trials from all tasks
  const allTrials: TrialResult[] = runResult.taskResults.flatMap((tr) => tr.trials);

  if (taskId !== undefined) {
    // Show detail for specific task
    printTaskDetail(taskId, allTrials);
  } else {
    // Show summary
    printSummary(runResult);
  }
}

main().catch((err: unknown) => {
  console.error(
    "[show-transcript] ERROR:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
