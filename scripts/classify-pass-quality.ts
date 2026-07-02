#!/usr/bin/env bun
/**
 * classify-pass-quality.ts
 *
 * P0 "lucky-pass scoring" from docs/harness-engineering-roadmap.md (AgentLens,
 * https://arxiv.org/abs/2605.12925). A static-analysis pass over eval
 * transcripts ALREADY ON DISK — zero new model calls, zero Ollama, fully
 * offline. Classifies each PASSING trajectory as Lucky / Solid / Ideal so a
 * binary "solved" outcome can be audited for process quality.
 *
 * IMPORTANT: this is a HEURISTIC PROCESS-QUALITY AUDIT, not a new correctness
 * metric. It does not change pass@1/pass@k, does not touch the agent loop,
 * and is purely additive. See classifyPassQuality() below for the exact
 * (documented, conservative) signals used and their known limits.
 *
 * Usage:
 *   bun scripts/classify-pass-quality.ts [--repo <path>] [--task <taskId>] [--json]
 *
 * Options:
 *   --repo <path>   Repo root to resolve the transcripts dir under (default: this repo)
 *   --task <taskId> Only classify transcripts for one task
 *   --json          Emit a single JSON object instead of the table
 *
 * Exit codes:
 *   0 — always (this is a report, not a gate; an empty/missing transcripts
 *       dir prints a message and exits 0 rather than crashing)
 */

import { resolve } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { TranscriptStore } from "../src/eval/transcript-store.ts";
import type { Transcript } from "../src/eval/types.ts";

// ---------------------------------------------------------------------------
// Heuristic thresholds — named + documented. These are deliberately simple
// proxies over the fields TurnRecord/Transcript actually carry; see the
// comments on classifyPassQuality() for each signal's known limits.
// ---------------------------------------------------------------------------

/**
 * Roadmap signal (a): "≥2 revert-and-retry cycles before green with NO change
 * in failureSignature between those attempts" — the model is churning
 * (retrying blindly) rather than diagnosing. A `TurnRecord.reverted` marks a
 * turn whose edit regressed previously-green tests and was rolled back — a
 * revert-and-retry cycle, by definition, in this codebase's semantics.
 */
const LUCKY_MIN_REVERT_CYCLES = 2;

/**
 * Ideal-shape boundary: "few turns, explore→edit→verify" per the roadmap's
 * Ideal description. Chosen as a small, round cutoff — NOT derived from any
 * measured distribution of turn counts. A transcript with more turns than
 * this can still be Solid; it just doesn't qualify for the (deliberately
 * strict) Ideal bucket.
 */
const IDEAL_MAX_TURNS = 3;

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

export type PassQuality = "lucky" | "solid" | "ideal";

export interface PassQualityResult {
  quality: PassQuality;
  signals: string[];
}

/**
 * Classify a single PASSING transcript's trajectory quality.
 *
 * ASSUMES `t.outcome === "passed"` — this function only looks at turn shape,
 * it does not re-check outcome. Callers (see `classifyTranscripts` below)
 * are responsible for filtering to passing transcripts first.
 *
 * Heuristic, not ground truth. Known limits (documented per-signal below):
 *   - `FailureDiagnostic` has no file/path field, so "the fix targeted the
 *     right file" cannot be verified directly — signals here use
 *     diagnostic PRESENCE as a conservative proxy for "some diagnosis
 *     happened," not proof the diagnosis and the fix are causally linked.
 *   - Where the data needed to judge a signal is missing (e.g. no
 *     `failureSignature` recorded on revert turns), we DEGRADE — skip that
 *     signal rather than guess Lucky. Solid is the safe default.
 */
export function classifyPassQuality(t: Transcript): PassQualityResult {
  const turns = t.turns;
  const signals: string[] = [];

  // --- Lucky signal (a): churn — ≥N revert cycles, same failureSignature ---
  // throughout (retrying without the diagnosis actually changing).
  const revertTurns = turns.filter((turn) => turn.reverted !== undefined);
  if (revertTurns.length >= LUCKY_MIN_REVERT_CYCLES) {
    const sigs = revertTurns
      .map((turn) => turn.failureSignature)
      .filter((s): s is string => s !== undefined);
    // Only judge this signal when EVERY revert turn actually recorded a
    // signature — a partial record can't tell us whether it "changed."
    if (sigs.length === revertTurns.length && sigs.every((s) => s === sigs[0])) {
      signals.push(
        `churn: ${revertTurns.length} revert-and-retry cycles with unchanged failureSignature ("${sigs[0]}")`,
      );
    }
  }

  // A run "struggled" if it actually thrashed — a reverted attempt, more than a
  // clean-solve number of turns, or ≥2 DISTINCT failure signatures (multiple
  // different failed attempts). We do NOT count a single persistent failure
  // signature: in fix-mode the baseline is red, so the very first turn always
  // carries the baseline signature — that is the task, not thrashing. Counting
  // "any signature" (the earlier definition) flagged every clean diagnose→fix as
  // struggled (forensic on realrepo-dequal-multifile: a clean 2-turn solve was
  // mislabeled Lucky via the untargeted-fix signal). A clean solve — few turns,
  // no reverts, one persistent baseline signature — is the BEST case, not lucky.
  const distinctFailSigs = new Set(
    turns.map((t) => t.failureSignature).filter((s): s is string => s !== undefined),
  ).size;
  const struggled =
    revertTurns.length > 0 || turns.length > IDEAL_MAX_TURNS || distinctFailSigs >= 2;

  // --- Lucky signal (c): never localized — the run STRUGGLED (failed at least
  // once) yet no turn ever carried a diagnostic: it thrashed toward green
  // without a structured diagnosis rather than diagnosing the failure.
  const anyDiagnostic = turns.some((turn) => turn.diagnostic !== undefined);
  if (struggled && !anyDiagnostic && turns.length > 0) {
    signals.push("never-localized: run failed yet no turn carried a diagnostic before green");
  }

  // --- Lucky signal (b): untargeted final edit ---
  // Conservative proxy: the LAST turn that successfully applied an edit (the
  // one that plausibly produced the green result) carried no diagnostic of
  // its own, even though diagnosis existed EARLIER in the run. That earlier
  // diagnosis apparently didn't drive the turn that actually solved it.
  // Limits: FailureDiagnostic carries no file, so this cannot confirm the
  // solving edit targeted an "unrelated" file — it only checks diagnostic
  // presence on the solving turn as a proxy for "targeted diagnosis."
  const editTurns = turns.filter((turn) =>
    turn.applyResults.some((r) => r.status === "applied"),
  );
  const solvingTurn = editTurns.length > 0 ? editTurns[editTurns.length - 1] : undefined;
  if (
    struggled &&
    solvingTurn !== undefined &&
    solvingTurn.diagnostic === undefined &&
    anyDiagnostic &&
    !signals.some((s) => s.startsWith("never-localized"))
  ) {
    signals.push(
      `untargeted-fix: the solving edit (turn ${solvingTurn.turn}) carried no diagnostic, though earlier turns did`,
    );
  }

  if (signals.length > 0) {
    return { quality: "lucky", signals };
  }

  // --- Ideal: clean explore -> edit -> verify shape ---
  // A clean solve is few turns, no reverts, no recovery prompts, AND it applied
  // an edit (a zero-edit "pass" is a no-op fixture, not a solve — falls to Solid).
  // We do NOT require a diagnostic: the cleanest solves (1-turn off a stack
  // trace) never produce one because they never failed. `struggled` being false
  // already guarantees no revert / no failure signature / few turns.
  const noReverts = revertTurns.length === 0;
  const fewTurns = turns.length > 0 && turns.length <= IDEAL_MAX_TURNS;
  const noRecovery = turns.every((turn) => !turn.redrafted && !turn.answerNow);
  const appliedAnEdit = solvingTurn !== undefined;

  if (!struggled && noReverts && fewTurns && noRecovery && appliedAnEdit) {
    return {
      quality: "ideal",
      signals: [
        `clean shape: ${turns.length} turn(s), no reverts, no recovery, applied edit on turn ${solvingTurn?.turn}`,
      ],
    };
  }

  return { quality: "solid", signals: [] };
}

/**
 * Filter to PASSING transcripts and classify each. Non-passing transcripts
 * are excluded entirely — this is the only place `outcome` is checked.
 */
export function classifyTranscripts(
  transcripts: Transcript[],
): Array<{ transcript: Transcript; quality: PassQuality; signals: string[] }> {
  return transcripts
    .filter((t) => t.outcome === "passed")
    .map((t) => {
      const { quality, signals } = classifyPassQuality(t);
      return { transcript: t, quality, signals };
    });
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface TaskTally {
  taskId: string;
  ideal: number;
  solid: number;
  lucky: number;
}

function tallyByTask(
  classified: Array<{ transcript: Transcript; quality: PassQuality }>,
): TaskTally[] {
  const byTask = new Map<string, TaskTally>();
  for (const { transcript, quality } of classified) {
    const existing = byTask.get(transcript.taskId) ?? {
      taskId: transcript.taskId,
      ideal: 0,
      solid: 0,
      lucky: 0,
    };
    existing[quality] += 1;
    byTask.set(transcript.taskId, existing);
  }
  return [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function luckyRate(t: TaskTally): number {
  const total = t.ideal + t.solid + t.lucky;
  return total === 0 ? 0 : t.lucky / total;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padStart(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function printTable(tallies: TaskTally[]): void {
  const COL1 = 36;
  const COL2 = 7;
  const COL3 = 7;
  const COL4 = 7;
  const COL5 = 10;
  const sep = `${"-".repeat(COL1)}-+-${"-".repeat(COL2)}-+-${"-".repeat(COL3)}-+-${"-".repeat(COL4)}-+-${"-".repeat(COL5)}`;

  console.log(
    `\n${padEnd("task-id", COL1)} | ${padEnd("ideal", COL2)} | ${padEnd("solid", COL3)} | ${padEnd("lucky", COL4)} | ${"lucky-rate"}`,
  );
  console.log(sep);

  let totalIdeal = 0;
  let totalSolid = 0;
  let totalLucky = 0;

  for (const t of tallies) {
    totalIdeal += t.ideal;
    totalSolid += t.solid;
    totalLucky += t.lucky;
    console.log(
      `${padEnd(t.taskId, COL1)} | ${padStart(String(t.ideal), COL2)} | ${padStart(String(t.solid), COL3)} | ${padStart(String(t.lucky), COL4)} | ${(luckyRate(t) * 100).toFixed(1)}%`,
    );
  }

  console.log(sep);
  const overall: TaskTally = { taskId: "OVERALL", ideal: totalIdeal, solid: totalSolid, lucky: totalLucky };
  console.log(
    `${padEnd("OVERALL", COL1)} | ${padStart(String(totalIdeal), COL2)} | ${padStart(String(totalSolid), COL3)} | ${padStart(String(totalLucky), COL4)} | ${(luckyRate(overall) * 100).toFixed(1)}%`,
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const asJson = flags["json"] === true;

  const repoRoot =
    typeof flags["repo"] === "string" ? resolve(flags["repo"]) : resolve(import.meta.dir, "..");
  const taskFilter = typeof flags["task"] === "string" ? flags["task"] : undefined;

  let transcriptsDir = resolve(repoRoot, "evals", "transcripts");
  try {
    const cfg = loadConfig(resolve(repoRoot, "smallcode.config.json")).config;
    if (cfg.eval?.transcriptsDir) {
      transcriptsDir = resolve(repoRoot, cfg.eval.transcriptsDir);
    }
  } catch {
    // No config, or invalid — fall back to the default transcripts dir.
  }

  if (!asJson) {
    console.log(
      "[classify-pass-quality] Heuristic process-quality audit (Lucky/Solid/Ideal) of PASSING " +
        "transcripts — NOT a new correctness metric. Zero model calls, fully offline.",
    );
  }

  const store = new TranscriptStore(transcriptsDir);
  let transcripts: Transcript[];
  try {
    transcripts = await store.loadAll(taskFilter);
  } catch {
    transcripts = [];
  }

  if (transcripts.length === 0) {
    if (asJson) {
      console.log(JSON.stringify({ message: "no transcripts found", transcriptsDir, tasks: {}, overall: null }));
    } else {
      console.log(`No transcripts found under ${transcriptsDir}. Nothing to classify.`);
    }
    process.exit(0);
  }

  const classified = classifyTranscripts(transcripts);

  if (classified.length === 0) {
    if (asJson) {
      console.log(
        JSON.stringify({ message: "no passing transcripts found", transcriptsDir, tasks: {}, overall: null }),
      );
    } else {
      console.log(`Found ${transcripts.length} transcript(s) under ${transcriptsDir}, but none passed. Nothing to classify.`);
    }
    process.exit(0);
  }

  const tallies = tallyByTask(classified);
  const overall: TaskTally = tallies.reduce(
    (acc, t) => ({ taskId: "OVERALL", ideal: acc.ideal + t.ideal, solid: acc.solid + t.solid, lucky: acc.lucky + t.lucky }),
    { taskId: "OVERALL", ideal: 0, solid: 0, lucky: 0 },
  );

  if (asJson) {
    const tasksObj: Record<string, { ideal: number; solid: number; lucky: number; luckyRate: number }> = {};
    for (const t of tallies) {
      tasksObj[t.taskId] = { ideal: t.ideal, solid: t.solid, lucky: t.lucky, luckyRate: luckyRate(t) };
    }
    console.log(
      JSON.stringify({
        message: "heuristic process-quality audit, not a correctness metric",
        transcriptsDir,
        totalPassingClassified: classified.length,
        tasks: tasksObj,
        overall: { ideal: overall.ideal, solid: overall.solid, lucky: overall.lucky, luckyRate: luckyRate(overall) },
      }),
    );
  } else {
    printTable(tallies);
    console.log(`\nTotal passing transcripts classified: ${classified.length}`);
  }

  process.exit(0);
}

if (import.meta.main) {
  await main();
}
