import type { EvalRunResult, TaskEvalResult, Transcript, TrialResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtScore(n: number): string {
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------
// renderTranscript
// ---------------------------------------------------------------------------

export function renderTranscript(transcript: Transcript): string {
  const lines: string[] = [];
  const durationMs = transcript.finishedAt - transcript.startedAt;

  lines.push(`=== Transcript: ${transcript.id} ===`);
  lines.push(
    `Task: ${transcript.taskId}  Trial: ${transcript.trialIndex}  Model: ${transcript.modelId}`,
  );
  lines.push(`Outcome: ${transcript.outcome}  Duration: ${fmtSeconds(durationMs)}`);

  if (transcript.turns.length === 0) {
    lines.push("(no turns)");
    return lines.join("\n");
  }

  for (const turn of transcript.turns) {
    lines.push("");
    lines.push(`--- Turn ${turn.turn} / Goal: ${turn.goalId} ---`);

    if (turn.reasoning !== undefined && turn.reasoning.trim().length > 0) {
      lines.push(`[REASONING] ${truncate(turn.reasoning.trim(), 200)}`);
    }

    if (turn.answer.trim().length > 0) {
      lines.push("[ANSWER]");
      lines.push(truncate(turn.answer.trim(), 500));
    }

    if (turn.toolCalls.length > 0) {
      lines.push("[TOOL CALLS]");
      for (let i = 0; i < turn.toolCalls.length; i++) {
        const tc = turn.toolCalls[i];
        const tr = turn.toolResults[i];
        const argsStr = JSON.stringify(tc?.args ?? {});
        const status =
          tr !== undefined ? (tr.success ? "success" : `error: ${tr.error ?? ""}`) : "?";
        lines.push(`  ${tc?.name ?? "?"}(${truncate(argsStr, 80)}) → ${status}`);
      }
    }

    if (turn.applyResults.length > 0) {
      lines.push("[EDITS]");
      for (const ar of turn.applyResults) {
        const statusStr =
          ar.status === "applied"
            ? "applied"
            : `${ar.status}${ar.error !== undefined ? `: ${ar.error}` : ""}`;
        lines.push(`  ${ar.filePath} — ${statusStr}`);
      }
    }

    lines.push("---");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// renderTrialResult
// ---------------------------------------------------------------------------

export function renderTrialResult(result: TrialResult): string {
  const lines: string[] = [];
  const passedStr = result.passed ? "YES" : "NO";

  lines.push(
    `Task: ${result.taskId}  Trial ${result.trialIndex}  Passed: ${passedStr}  Score: ${fmtScore(result.partialScore)}`,
  );
  lines.push("Graders:");

  for (const gr of result.graderResults) {
    const verdictStr = gr.verdict.toUpperCase();
    const scoreStr = `(${fmtScore(gr.score)})`;
    const durationStr = `${gr.durationMs}ms`;

    // Extract short detail (first line of output if relevant)
    const firstLine = gr.output.split("\n").find((l) => l.trim().length > 0) ?? "";
    const detail =
      gr.verdict !== "pass" && firstLine.length > 0 ? ` — ${truncate(firstLine, 60)}` : "";

    lines.push(`  ${gr.type}: ${verdictStr} ${scoreStr}  ${durationStr}${detail}`);
  }

  const m = result.metrics;
  lines.push(
    `Metrics: turns=${m.nTurns} tokens=${m.nTotalTokens} latency=${fmtSeconds(m.latencyMs)}`,
  );

  if (result.error !== undefined) {
    lines.push(`Error: ${result.error}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// renderEvalRunResult
// ---------------------------------------------------------------------------

export function renderEvalRunResult(result: EvalRunResult): string {
  const lines: string[] = [];
  const duration = result.finishedAt - result.startedAt;

  lines.push(`=== Eval Run: ${result.runId} ===`);
  lines.push(`Suite: ${result.suiteId}  Model: ${result.modelId}`);
  lines.push(
    `Started: ${new Date(result.startedAt).toISOString()}  Duration: ${fmtSeconds(duration)}`,
  );
  lines.push("");
  lines.push("Task Results:");

  // Header row
  const COL_ID = 32;
  const COL_PASS = 8;
  const COL_TRIALS = 8;
  const COL_SCORE = 10;
  lines.push(
    `  ${pad("task-id", COL_ID)} ${pad("pass@1", COL_PASS)} ${pad("trials", COL_TRIALS)} ${pad("avg_score", COL_SCORE)}`,
  );

  for (const tr of result.taskResults) {
    const taskId = tr.task.id;
    const passAt1 = fmtScore(tr.passAt1);
    const trialCount = String(tr.trials.length);
    const avgScore = fmtScore(tr.avgPartialScore);
    lines.push(
      `  ${pad(taskId, COL_ID)} ${pad(passAt1, COL_PASS)} ${pad(trialCount, COL_TRIALS)} ${pad(avgScore, COL_SCORE)}`,
    );
  }

  lines.push("");
  const passedCount = result.totalTasksPassed;
  const totalTasks = result.taskResults.length;
  lines.push(
    `Overall pass@1: ${fmtScore(result.overallPassAt1)} (${passedCount}/${totalTasks} tasks)`,
  );
  lines.push(`Total trials: ${result.totalTrials}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Re-export TaskEvalResult so it can be used in tests without reaching into types
// ---------------------------------------------------------------------------
export type { TaskEvalResult };
