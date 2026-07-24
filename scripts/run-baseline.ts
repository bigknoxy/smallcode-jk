#!/usr/bin/env bun
/**
 * Baseline runner for the capability eval suite.
 *
 * Dry-run mode (SMALLCODE_DRY_RUN=1):
 *   Verifies all tasks have reference solutions and all graders pass against fixtures.
 *   Exits 0 if all pass, 1 if any fail.
 *
 * Live mode (default):
 *   Runs the full agent harness at k=5 trials per task and records metrics.
 *   Requires SMALLCODE_* env vars for model/provider config.
 *
 * Usage:
 *   SMALLCODE_DRY_RUN=1 bun scripts/run-baseline.ts
 *   bun scripts/run-baseline.ts
 */

import { mkdir, cp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "../src/config/env.ts";
import { loadConfig } from "../src/config/loader.ts";
import { defaultTemperatures } from "../src/agent/bestofn-loop.ts";
import { classifyTranscripts } from "./classify-pass-quality.ts";
import { saveTrialTranscripts } from "../src/eval/save-transcripts.ts";
import { summarizeRepairs } from "../src/eval/repair-metrics.ts";
import { runTask } from "../src/eval/task-runner.ts";
import { bootstrapCI, passAtKFromFlags } from "../src/eval/stats.ts";
import { loadSuite } from "../src/eval/task-loader.ts";
import { TranscriptStore } from "../src/eval/transcript-store.ts";
import { runDeterministicGrader } from "../src/eval/graders/deterministic.ts";
import { runStaticGrader } from "../src/eval/graders/static.ts";
import type { EvalTask, GraderConfig, GraderResult, TaskEvalResult } from "../src/eval/types.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { buildEscalationLadder } from "../src/agent/escalation.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import type { MetricsSnapshot, TaskBehavior } from "../src/improve/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..");
// Suite is overridable via SMALLCODE_SUITE (bare name resolved under
// evals/suites/, or an explicit path). Defaults to the capability suite so the
// historical baseline command is unchanged.
const SUITE_NAME = process.env.SMALLCODE_SUITE ?? "capability";
const SUITE_DIR = SUITE_NAME.includes("/")
  ? resolve(PROJECT_ROOT, SUITE_NAME)
  : join(PROJECT_ROOT, "evals", "suites", SUITE_NAME);
const FIXTURES_DIR = join(PROJECT_ROOT, "evals", "fixtures");
const METRICS_HISTORY_PATH = join(PROJECT_ROOT, "evals", "metrics-history.jsonl");
// Trial dirs MUST live outside the project tree: a project-local tmp dir would
// inherit the repo bunfig.toml (`[test] root = "tests"`), scoping `bun test`
// inside each trial to a non-existent `<trial>/tests` and finding 0 test files.
// The live harness (trial-env.ts) already uses the OS tmpdir for this reason.
const TMP_BASE = join(tmpdir(), "smallcode-baseline");

const DRY_RUN = process.env.SMALLCODE_DRY_RUN === "1";
// Eval-specific overrides: fewer turns + trials to keep total wall-clock under ~30 min.
// Production config has maxTurns=15; eval only needs enough to attempt + verify a fix.
const EVAL_MAX_TURNS = Number(process.env.SMALLCODE_EVAL_MAX_TURNS ?? "5");
const EVAL_K = Number(process.env.SMALLCODE_EVAL_K ?? "3");
// A/B toggles (default = production behavior). SMALLCODE_DISCIPLINE=0 strips the
// Karpathy discipline rules from the system prompt; SMALLCODE_PRESOLVE=1 enables
// the planner pre-solve reflection step. Used to measure each against baseline.
const DISCIPLINE = process.env.SMALLCODE_DISCIPLINE !== "0";
const PRESOLVE = process.env.SMALLCODE_PRESOLVE === "1";
// max_tokens A/B: attack think-only truncation at the CAUSE (generation budget)
// rather than the symptom (recovery). Overrides the model profile's
// samplingDefaults.max_tokens for the run. Larger = more room to think AND
// answer (fewer truncations) but a smaller prompt budget (num_ctx − max_tokens).
// Unset = registry default (4096). e.g. SMALLCODE_MAX_TOKENS=6144.
const MAX_TOKENS_OVERRIDE = process.env.SMALLCODE_MAX_TOKENS
  ? Number(process.env.SMALLCODE_MAX_TOKENS)
  : undefined;
// Temperature A/B: temp=1.0 (registry default for VibeThinker-3B) is suspected
// to drive BOTH the think-only reasoning spirals and the huge run-to-run pass@1
// variance. Lowering it should reduce both. Unset = registry default.
// e.g. SMALLCODE_TEMP=0.6.
const TEMP_OVERRIDE = process.env.SMALLCODE_TEMP
  ? Number(process.env.SMALLCODE_TEMP)
  : undefined;
// Model swap: override config.activeModel for a cross-model A/B (e.g. compare a
// non-reasoning coder model against VibeThinker on the same suite/n). Must name a
// registered profile whose id equals the Ollama model name. Unset = config default.
// e.g. SMALLCODE_MODEL=qwen2.5-coder:3b.
const MODEL_OVERRIDE = process.env.SMALLCODE_MODEL || undefined;
// Inject an evolved PromptSet (e.g. evals/gepa-best.json from a GEPA run) so the
// held-out suite can be scored with the optimized prompt vs the default. The file
// must contain a `prompts` object with {system, planner, reflection, skill?}.
const PROMPTSET_PATH = process.env.SMALLCODE_PROMPTSET || undefined;
// Measuring-stick controls. SMALLCODE_EVAL_N is the SAMPLE COUNT n (trials per
// task) — decoupled from the reported k. SMALLCODE_REPORT_KS is the comma list
// of k values to report pass@k for. Larger n → tighter confidence intervals
// (CI width shrinks ~1/√n). EVAL_N falls back to the legacy EVAL_K when unset so
// existing invocations keep working.
const EVAL_N = Number(process.env.SMALLCODE_EVAL_N ?? process.env.SMALLCODE_EVAL_K ?? "10");
const REPORT_KS = (process.env.SMALLCODE_REPORT_KS ?? "1,2,3,5")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((k) => Number.isFinite(k) && k >= 1);
// Fixed seed → reproducible bootstrap CIs across reruns of the same outcomes.
const CI_SEED = process.env.SMALLCODE_CI_SEED ? Number(process.env.SMALLCODE_CI_SEED) : 0xc0ffee;
// Run-level oracle-verified Best-of-N. >1 makes EACH of the n trials run up to N
// independent full-loop attempts (temperature-swept), resolving on the first
// deterministic-green — so the reported pass@1 IS the empirical pass@N(any) of
// the shipped BoN mechanism, and avg_attempts shows the cost (≤ N via early
// stop). Default 1 = plain single-shot, identical to prior behaviour.
const BEST_OF_N = Math.max(1, Number(process.env.SMALLCODE_BEST_OF_N ?? "1"));
// R1 escalation ladder: comma-separated model ids, cheapest first, applied across
// Best-of-N attempts (e.g. "qwen2.5-coder:3b,qwen2.5-coder:3b,qwen2.5-coder:7b").
// Unset = no escalation. Only meaningful with SMALLCODE_BEST_OF_N>1.
const ESCALATION = process.env.SMALLCODE_ESCALATION;
// Optional substring filter for a focused subset of a suite (comma-separated;
// a task matches if its id contains ANY term). Unset = whole suite.
const TASK_FILTER = (process.env.SMALLCODE_TASK_FILTER ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
// Issue #95: SMALLCODE_SAVE_TRANSCRIPTS=1 persists every trial's Transcript to
// TRANSCRIPTS_DIR via the same TranscriptStore layout `eval run
// --save-transcripts` uses (<taskId>/<id>.json), so
// scripts/classify-pass-quality.ts has real data to read. OFF by default =
// zero behavior/output change (transcripts can be large).
const SAVE_TRANSCRIPTS = env.saveTranscripts;
const TRANSCRIPTS_DIR = join(PROJECT_ROOT, "evals", "transcripts");
const transcriptStore = SAVE_TRANSCRIPTS ? new TranscriptStore(TRANSCRIPTS_DIR) : undefined;
let transcriptsSavedTotal = 0;

// ---------------------------------------------------------------------------
// Grader dispatch (same as validate-e1)
// ---------------------------------------------------------------------------

async function runGrader(grader: GraderConfig, trialDir: string): Promise<GraderResult> {
  switch (grader.type) {
    case "deterministic_tests":
      return runDeterministicGrader(grader, trialDir);
    case "static_analysis":
      return runStaticGrader(grader, trialDir);
    case "llm_rubric":
      return {
        type: "llm_rubric" as const,
        verdict: "unknown" as const,
        score: 0,
        output: "llm_rubric grader skipped in baseline runner",
        durationMs: 0,
      };
  }
}

// ---------------------------------------------------------------------------
// Dry-run: validate reference solution against graders
// ---------------------------------------------------------------------------

interface DryRunResult {
  taskId: string;
  passed: boolean;
  reason?: string;
  durationMs: number;
}

async function dryRunTask(task: EvalTask): Promise<DryRunResult> {
  const { id: taskId, referenceSolution } = task;
  const startMs = Date.now();

  if (!referenceSolution) {
    return { taskId, passed: false, reason: "no referenceSolution field", durationMs: 0 };
  }

  const trialDir = join(TMP_BASE, taskId);

  try {
    await rm(trialDir, { recursive: true, force: true });
    await mkdir(trialDir, { recursive: true });

    // Mirror the live harness (trial-env.ts): lay down the full repoFixture (or
    // inline files), THEN overlay the referenceSolution. For repoFixture-style
    // tasks the solution dir is a sparse overlay (just the corrected file), so
    // copying it alone would omit the tests and grade against an empty repo.
    if (task.setup.repoFixture !== undefined) {
      await cp(join(FIXTURES_DIR, task.setup.repoFixture), trialDir, { recursive: true });
    }
    if (task.setup.files !== undefined) {
      for (const [relPath, content] of Object.entries(task.setup.files)) {
        const abs = join(trialDir, relPath);
        await mkdir(join(abs, ".."), { recursive: true });
        await Bun.write(abs, content);
      }
    }
    await cp(join(FIXTURES_DIR, referenceSolution), trialDir, { recursive: true });

    const graderResults = await Promise.all(
      task.graders.map((grader) => runGrader(grader, trialDir)),
    );

    const allPassed = graderResults.every((r) => r.verdict === "pass");
    if (!allPassed) {
      const failures = graderResults
        .filter((r) => r.verdict !== "pass")
        .map((r) => `${r.type}=${r.verdict}: ${r.output.slice(0, 200)}`)
        .join("; ");
      return { taskId, passed: false, reason: failures, durationMs: Date.now() - startMs };
    }

    return { taskId, passed: true, durationMs: Date.now() - startMs };
  } catch (err) {
    return {
      taskId,
      passed: false,
      reason: `exception: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startMs,
    };
  } finally {
    await rm(trialDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Summary table helpers
// ---------------------------------------------------------------------------

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padStart(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function printDryRunTable(results: DryRunResult[]): void {
  const COL1 = 32;
  const COL2 = 8;
  const COL3 = 10;

  const sep = `${"-".repeat(COL1)}-+-${"-".repeat(COL2)}-+-${"-".repeat(COL3)}`;
  console.log(`\n${padEnd("task-id", COL1)} | ${padEnd("result", COL2)} | ${"duration"}`);
  console.log(sep);
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log(
      `${padEnd(r.taskId, COL1)} | ${padEnd(status, COL2)} | ${padStart(`${r.durationMs}ms`, COL3)}`,
    );
    if (!r.passed && r.reason) {
      console.log(`  reason: ${r.reason}`);
    }
  }
  console.log(sep);
}

// ---------------------------------------------------------------------------
// Live-run stubs (not exercised in dry-run)
// ---------------------------------------------------------------------------

interface LiveTaskMetrics {
  taskId: string;
  /** Effective sample count after excluding infra-error trials. */
  n: number;
  passAt1: number;
  /** pass@k point estimate per reported k. */
  passAtK: Record<number, number>;
  /** 95% bootstrap CI per reported k. */
  passAtKCI: Record<number, { lo: number; hi: number }>;
  /** Pass/fail flags (infra-error trials excluded) — for suite pooling. */
  passedFlags: boolean[];
  avgTurns: number;
  avgTokens: number;
  /** Fraction of trials that produced ≥1 cleanly-applied edit (Aider-style
   * "correct edit format %"). The harness-thesis metric: a weak model fails on
   * edit format, not reasoning. */
  editFormatPct: number;
  /** Total think-only (truncated mid-reasoning) turns across all trials. */
  thinkOnlyTurns: number;
  /** Number of trials that hit ≥1 think-only truncation. */
  trialsWithTruncation: number;
  /** Trials dropped from the rate because the grader hit a transient infra error. */
  infraDropped: number;
  /** Best-of-N attempts allowed per trial (1 = single-shot). */
  bestOfN: number;
  /** Mean BoN attempts actually spent per trial (≤ bestOfN; undefined when off). */
  avgAttemptsUsed?: number;
  /** Repair-path telemetry (summed across trials): successfully-applied edit
   * blocks, how many needed a non-exact fuzzy-repair salvage, and the per-
   * strategy breakdown. The measurable payoff ceiling for any edit-FORMAT
   * change (see docs/harness-engineering-roadmap.md P2 verdict). */
  appliedEdits: number;
  repaired: number;
  repairByStrategy: Record<string, number>;
}

/** Count turns whose tool results carry the think-only truncation error. */
function countThinkOnlyTurns(turns: import("@/agent/types.ts").TurnRecord[]): number {
  return turns.filter((t) => t.toolResults.some((r) => r.error?.includes("think-only"))).length;
}

/** A trial whose deterministic grader hit a transient infra error (lockfile,
 * EAGAIN, …) never actually ran the tests — exclude it from the rate rather
 * than count it as a model failure. */
function trialHitInfraError(trial: TaskEvalResult["trials"][number]): boolean {
  // (a) Grader subprocess infra fault (lockfile/EAGAIN), marked after retries.
  if (trial.graderResults.some((r) => r.details?.["infraError"] === true)) return true;
  // (b) Empty-generation wedge: the provider returned zero tokens for EVERY turn
  // (loop tags these "infra: empty model generation"). A disconnected/wedged backend
  // never gave the model a real chance — excluding it stops a flap from forging a
  // false 0.00. Requiring ALL turns empty keeps a real model fail (any real token)
  // in the denominator; the wedge signature is a whole trial of nothing.
  const turns = trial.transcript?.turns ?? [];
  if (
    turns.length > 0 &&
    turns.every((t) =>
      t.toolResults.some((r) => r.error?.includes("infra: empty model generation")),
    )
  ) {
    return true;
  }
  return false;
}

async function liveRunTask(task: EvalTask): Promise<LiveTaskMetrics> {
  const { config, extraModels } = loadConfig();
  for (const m of extraModels) defaultRegistry.register(m);

  // Optional evolved PromptSet (GEPA held-out validation). Loaded once per trial
  // call — cheap relative to a model turn; keeps the override fully env-driven.
  let promptSetOverride: import("../src/agent/prompt-set.ts").PromptSet | undefined;
  if (PROMPTSET_PATH) {
    const parsed = (await Bun.file(PROMPTSET_PATH).json()) as { prompts?: unknown };
    if (!parsed.prompts || typeof parsed.prompts !== "object") {
      throw new Error(`SMALLCODE_PROMPTSET ${PROMPTSET_PATH} has no "prompts" object`);
    }
    promptSetOverride = parsed.prompts as import("../src/agent/prompt-set.ts").PromptSet;
  }

  const activeModel = MODEL_OVERRIDE ?? config.activeModel;
  const baseProfile = defaultRegistry.get(activeModel);
  // Apply sampling overrides (cause-attack A/B: max_tokens and/or temperature) by
  // cloning the profile so the registry default is untouched for other consumers.
  const profile =
    MAX_TOKENS_OVERRIDE !== undefined || TEMP_OVERRIDE !== undefined
      ? {
          ...baseProfile,
          samplingDefaults: {
            ...baseProfile.samplingDefaults,
            ...(MAX_TOKENS_OVERRIDE !== undefined && { max_tokens: MAX_TOKENS_OVERRIDE }),
            ...(TEMP_OVERRIDE !== undefined && { temperature: TEMP_OVERRIDE }),
          },
        }
      : baseProfile;
  const provider = createProvider(config.provider, defaultRegistry);
  const reasoningHandler = new ReasoningHandler(
    profile.reasoningTags ?? { open: "<think>", close: "</think>" },
  );

  const agentConfig = {
    repoRoot: PROJECT_ROOT, // overridden per trial inside runTask
    modelId: profile.id,
    maxTurns: EVAL_MAX_TURNS,
    bestOfN: 1, // per-TURN candidate selection off; run-level BoN is below via SMALLCODE_BEST_OF_N
    allowedCommands: config.sandbox.allowedCommands,
    requireApproval: false,
    disciplineRules: DISCIPLINE,
    preSolveReflection: PRESOLVE,
    ...(promptSetOverride ? { promptSet: promptSetOverride } : {}),
  };

  const loopDeps = {
    provider,
    profile,
    reasoningHandler,
    config: agentConfig,
  };

  // R1 escalation ladder (SMALLCODE_ESCALATION). Only meaningful with BoN>1; the
  // base provider is reused (all local models share the Ollama endpoint).
  const escalationLadder = buildEscalationLadder({
    spec: ESCALATION,
    registry: defaultRegistry,
    provider,
  });

  const result: TaskEvalResult = await runTask(task, {
    trialsPerTask: EVAL_N,
    reportKs: REPORT_KS,
    ciSeed: CI_SEED,
    fixturesRoot: FIXTURES_DIR,
    agentConfig,
    loopDeps,
    bestOfN: BEST_OF_N,
    ...(escalationLadder ? { escalationLadder } : {}),
    trialTimeoutMs: 20 * 60 * 1000, // 20 min per trial (VibeThinker-3B ~100-300s/call)
  });

  if (transcriptStore) {
    transcriptsSavedTotal += await saveTrialTranscripts(transcriptStore, [result]);
  }

  // Exclude infra-error trials from the pass-rate denominator (the grader marks
  // them after exhausting retries). They never ran the tests; counting them as
  // model failures would inject harness noise into the rate.
  const cleanTrials = result.trials.filter((t) => !trialHitInfraError(t));
  const infraDropped = result.trials.length - cleanTrials.length;
  const passedFlags = cleanTrials.map((t) => t.passed);
  const n = passedFlags.length;

  // Recompute pass@k + CI from the infra-cleaned flags so the rate and its
  // interval reflect only real model outcomes. ks ∪ {n}, capped at n.
  const ks = [...new Set([...REPORT_KS, n])].filter((kk) => kk >= 1 && kk <= n).sort((a, b) => a - b);
  const passAtK: Record<number, number> = {};
  const passAtKCI: Record<number, { lo: number; hi: number }> = {};
  for (const kk of ks) {
    passAtK[kk] = passAtKFromFlags(passedFlags, kk);
    const ci = bootstrapCI(passedFlags, kk, { seed: CI_SEED });
    passAtKCI[kk] = { lo: ci.lo, hi: ci.hi };
  }

  const avgOf = (sel: (t: (typeof result.trials)[number]) => number): number =>
    result.trials.length === 0
      ? 0
      : result.trials.reduce((sum, t) => sum + sel(t), 0) / result.trials.length;
  const avgTurns = avgOf((t) => t.metrics.nTurns);
  const avgTokens = avgOf((t) => t.metrics.nTotalTokens);
  const editFormatPct = avgOf((t) => t.metrics.editFormatOk ?? 0);

  // Think-only truncation incidence — the premise check. How often does the
  // model burn its budget mid-reasoning and emit nothing? Per-trial counts from
  // the transcript turn records (loop tags these with a think-only error).
  const perTrialThinkOnly = result.trials.map((t) => countThinkOnlyTurns(t.transcript.turns));
  const thinkOnlyTurns = perTrialThinkOnly.reduce((sum, x) => sum + x, 0);
  const trialsWithTruncation = perTrialThinkOnly.filter((x) => x > 0).length;

  // Repair-path telemetry — how often an applied edit only matched after the
  // fuzzy-repair salvage (search text drifted). Summed across trials.
  const repairSummaries = result.trials.map((t) => summarizeRepairs(t.transcript.turns));
  const appliedEdits = repairSummaries.reduce((s, r) => s + r.appliedEdits, 0);
  const repaired = repairSummaries.reduce((s, r) => s + r.repaired, 0);
  const repairByStrategy = repairSummaries.reduce<Record<string, number>>((acc, r) => {
    for (const [k, v] of Object.entries(r.byStrategy)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});

  return {
    taskId: task.id,
    n,
    passAt1: passAtK[1] ?? (n > 0 ? passedFlags.filter(Boolean).length / n : 0),
    passAtK,
    passAtKCI,
    passedFlags,
    avgTurns,
    avgTokens,
    editFormatPct,
    thinkOnlyTurns,
    trialsWithTruncation,
    infraDropped,
    bestOfN: BEST_OF_N,
    avgAttemptsUsed: result.avgAttemptsUsed,
    appliedEdits,
    repaired,
    repairByStrategy,
  };
}

/** Render a pass@k point estimate with its CI, e.g. "0.70[.47-.90]". */
function fmtPK(point: number | undefined, ci: { lo: number; hi: number } | undefined): string {
  if (point === undefined) return "—";
  const b = (x: number) => x.toFixed(2).replace(/^0(?=\.)/, "");
  return ci ? `${point.toFixed(2)}[${b(ci.lo)}-${b(ci.hi)}]` : point.toFixed(2);
}

function printLiveTable(metrics: LiveTaskMetrics[]): void {
  const COL1 = 30;
  const COL2 = 15; // pass@1 [lo-hi]
  const COL3 = 15; // pass@K [lo-hi]
  const COL4 = 7; // n
  const COL5 = 9; // avg_turns
  const COL6 = 11; // think-only
  // The headline retry metric: largest reported k present across tasks.
  const bigK = Math.max(...metrics.flatMap((m) => Object.keys(m.passAtK).map(Number)), 1);
  const sep = `${"-".repeat(COL1)}-+-${"-".repeat(COL2)}-+-${"-".repeat(COL3)}-+-${"-".repeat(COL4)}-+-${"-".repeat(COL5)}-+-${"-".repeat(COL6)}`;
  console.log(
    `\n${padEnd("task-id", COL1)} | ${padEnd("pass@1 [95% CI]", COL2)} | ${padEnd(`pass@${bigK} [95% CI]`, COL3)} | ${padEnd("n", COL4)} | ${padEnd("avg_turns", COL5)} | ${padEnd("edit-fmt", 8)} | ${"think-only"}`,
  );
  console.log(sep);
  const bonActive = metrics.some((m) => m.bestOfN > 1);
  for (const m of metrics) {
    const bonCol =
      m.bestOfN > 1 && m.avgAttemptsUsed !== undefined
        ? ` BoN${m.bestOfN}@${m.avgAttemptsUsed.toFixed(1)}`
        : "";
    const repCol = m.appliedEdits > 0 ? ` rep:${m.repaired}/${m.appliedEdits}` : "";
    const truncCol = `${m.thinkOnlyTurns} (${m.trialsWithTruncation}t)${m.infraDropped > 0 ? ` !${m.infraDropped}infra` : ""}${bonCol}${repCol}`;
    const p1 = fmtPK(m.passAtK[1], m.passAtKCI[1]);
    const pK = fmtPK(m.passAtK[bigK], m.passAtKCI[bigK]);
    const editFmt = `${(m.editFormatPct * 100).toFixed(0)}%`;
    console.log(
      `${padEnd(m.taskId, COL1)} | ${padEnd(p1, COL2)} | ${padEnd(pK, COL3)} | ${padEnd(String(m.n), COL4)} | ${padEnd(m.avgTurns.toFixed(1), COL5)} | ${padEnd(editFmt, 8)} | ${truncCol}`,
    );
  }
  console.log(sep);

  // Suite-level pooled row: concat every task's clean flags, pass@k ± CI.
  const pooled = metrics.flatMap((m) => m.passedFlags);
  const overall1 = { p: passAtKFromFlags(pooled, 1), ci: bootstrapCI(pooled, 1, { seed: CI_SEED }) };
  const overallK = {
    p: passAtKFromFlags(pooled, bigK),
    ci: bootstrapCI(pooled, bigK, { seed: CI_SEED }),
  };
  const pooledEditFmt =
    pooled.length > 0
      ? metrics.reduce((s, m) => s + m.editFormatPct * m.n, 0) / metrics.reduce((s, m) => s + m.n, 0)
      : 0;
  console.log(
    `${padEnd("OVERALL (pooled)", COL1)} | ${padEnd(fmtPK(overall1.p, overall1.ci), COL2)} | ${padEnd(fmtPK(overallK.p, overallK.ci), COL3)} | ${padEnd(String(pooled.length), COL4)} | ${padEnd("", COL5)} | ${padEnd(`${(pooledEditFmt * 100).toFixed(0)}%`, 8)} |`,
  );
  // Repair-path telemetry summary — the baseline for any edit-FORMAT work
  // (P2 constrained-decoding closed NO-GO for lack of exactly this number).
  const totApplied = metrics.reduce((s, m) => s + m.appliedEdits, 0);
  const totRepaired = metrics.reduce((s, m) => s + m.repaired, 0);
  const byStrat = metrics.reduce<Record<string, number>>((acc, m) => {
    for (const [k, v] of Object.entries(m.repairByStrategy)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});
  const stratStr = ["whitespace", "fuzzy"].map((k) => `${k}=${byStrat[k] ?? 0}`).join(" ");
  const repRate = totApplied > 0 ? ((totRepaired / totApplied) * 100).toFixed(1) : "0.0";
  console.log(
    `\nRepair-path: ${totRepaired}/${totApplied} applied edits needed fuzzy-repair salvage (${repRate}%) — ${stratStr}. Exact matches = the rest. This is the payoff ceiling for edit-FORMAT changes; a low rate means edit format is already reliable.`,
  );
  console.log(
    "\nCI = 95% bootstrap over n trials. Two results differ significantly only when their CIs do NOT overlap. n<8 → treat CI as indicative only; raise SMALLCODE_EVAL_N to tighten.",
  );
  if (bonActive) {
    console.log(
      "BoN<N>@<a> = run-level Best-of-N: each trial = up to N temp-swept attempts, first deterministic-green wins; <a> = mean attempts spent (cost). pass@1 here IS the empirical pass@N(any) — compare its CI against a SMALLCODE_BEST_OF_N=1 baseline run.",
    );
  }
}

// ---------------------------------------------------------------------------
// MetricsSnapshot writer
// ---------------------------------------------------------------------------

async function appendMetricsSnapshot(snapshot: MetricsSnapshot): Promise<void> {
  const line = JSON.stringify(snapshot) + "\n";
  await appendFile(METRICS_HISTORY_PATH, line, "utf-8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = DRY_RUN ? "DRY RUN" : "LIVE";
  console.log(`[run-baseline] Mode: ${mode}`);
  console.log(`[run-baseline] Loading suite "${SUITE_NAME}" from ${SUITE_DIR}...`);

  const suite = await loadSuite(SUITE_DIR);
  // Optional substring filter (SMALLCODE_TASK_FILTER) — run a focused subset of a
  // suite (e.g. the localization-hard tasks) without authoring a temp suite dir.
  if (TASK_FILTER.length > 0) {
    const before = suite.tasks.length;
    suite.tasks = suite.tasks.filter((t) => TASK_FILTER.some((f) => t.id.includes(f)));
    console.log(`[run-baseline] TASK_FILTER [${TASK_FILTER.join(",")}] → ${suite.tasks.length}/${before} tasks`);
  }
  console.log(`[run-baseline] Found ${suite.tasks.length} tasks in suite "${suite.id}"\n`);

  await mkdir(TMP_BASE, { recursive: true });

  if (DRY_RUN) {
    // -----------------------------------------------------------------------
    // Dry-run: validate all reference solutions through their graders
    // -----------------------------------------------------------------------
    let passCount = 0;
    let failCount = 0;
    const results: DryRunResult[] = [];

    for (const task of suite.tasks) {
      process.stdout.write(`  Running ${task.id}...`);
      const result = await dryRunTask(task);
      results.push(result);
      if (result.passed) {
        passCount++;
        process.stdout.write(" PASS\n");
      } else {
        failCount++;
        process.stdout.write(" FAIL\n");
        if (result.reason) {
          console.log(`    reason: ${result.reason}`);
        }
      }
    }

    printDryRunTable(results);

    // Write a synthetic MetricsSnapshot so metrics-history.jsonl is populated
    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      runId: `dry-run-${Date.now()}`,
      suiteId: suite.id,
      modelId: "reference-solutions",
      overallPassAt1: passCount / suite.tasks.length,
      totalTasksPassed: passCount,
      totalTasks: suite.tasks.length,
      perTaskPassAt1: Object.fromEntries(results.map((r) => [r.taskId, r.passed ? 1 : 0])),
    };
    await appendMetricsSnapshot(snapshot);

    await rm(TMP_BASE, { recursive: true, force: true });

    console.log(`\n[run-baseline] Results: ${passCount} pass, ${failCount} fail`);
    console.log(`[run-baseline] Metrics appended to ${METRICS_HISTORY_PATH}`);

    if (failCount > 0) {
      process.exit(1);
    }

    console.log("[run-baseline] All reference solutions pass.");
  } else {
    // -----------------------------------------------------------------------
    // Live run: n = SMALLCODE_EVAL_N samples/task; report pass@k (k in
    // SMALLCODE_REPORT_KS) with 95% bootstrap CIs.
    // -----------------------------------------------------------------------
    console.log(`[run-baseline] n=${EVAL_N} samples/task, reporting pass@{${REPORT_KS.join(",")}} with 95% CI`);
    if (BEST_OF_N > 1) {
      console.log(
        `[run-baseline] run-level Best-of-N=${BEST_OF_N} ON (temps ${defaultTemperatures(BEST_OF_N).join(",")}) — pass@1 = empirical pass@${BEST_OF_N}(any); compare vs a SMALLCODE_BEST_OF_N=1 run.`,
      );
    }
    if (ESCALATION) {
      const rungs = ESCALATION.split(",").map((s) => s.trim()).filter(Boolean);
      console.log(
        `[run-baseline] R1 escalation ladder ON: attempt models = [${rungs.join(" → ")}] (clamped to last rung past ${rungs.length} attempts). Winning rung recorded per trial.`,
      );
    }
    const allMetrics: LiveTaskMetrics[] = [];
    let passCount = 0;

    const total = suite.tasks.length;
    for (let i = 0; i < suite.tasks.length; i++) {
      const task = suite.tasks[i];
      if (!task) continue;
      console.log(`  [${i + 1}/${total}] ${task.id}...`);
      try {
        const t0 = Date.now();
        const m = await liveRunTask(task);
        const elapsed = Math.round((Date.now() - t0) / 1000);
        allMetrics.push(m);
        if (m.passAt1 > 0) passCount++;
        const ci1 = m.passAtKCI[1];
        const ciStr = ci1 ? ` [${ci1.lo.toFixed(2)}-${ci1.hi.toFixed(2)}]` : "";
        if (m.n === 0) {
          // Every trial was infra-poisoned (e.g. wedged backend) — UNMEASURED, not 0.00.
          console.log(
            `        UNMEASURED — all ${m.infraDropped} trials hit infra errors (no real model output). Restart backend + rerun this task. (${elapsed}s)`,
          );
        } else {
          console.log(
            `        pass@1=${m.passAt1.toFixed(2)}${ciStr} n=${m.n} turns=${m.avgTurns.toFixed(1)} think-only=${m.thinkOnlyTurns}(${m.trialsWithTruncation}t)${m.infraDropped ? ` infra-dropped=${m.infraDropped}` : ""} (${elapsed}s)`,
          );
        }
      } catch (err) {
        console.error(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    printLiveTable(allMetrics);

    // Suite-level pooled aggregate for the snapshot.
    const pooledFlags = allMetrics.flatMap((m) => m.passedFlags);
    const snapKs = [...new Set([...REPORT_KS, pooledFlags.length])]
      .filter((kk) => kk >= 1 && kk <= pooledFlags.length)
      .sort((a, b) => a - b);
    const overallPassAtK: Record<number, number> = {};
    const overallCI: Record<number, { lo: number; hi: number }> = {};
    for (const kk of snapKs) {
      overallPassAtK[kk] = passAtKFromFlags(pooledFlags, kk);
      const ci = bootstrapCI(pooledFlags, kk, { seed: CI_SEED });
      overallCI[kk] = { lo: ci.lo, hi: ci.hi };
    }

    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      runId: `live-${Date.now()}`,
      suiteId: suite.id,
      modelId: MODEL_OVERRIDE ?? loadConfig().config.activeModel,
      overallPassAt1: overallPassAtK[1] ?? (pooledFlags.length ? pooledFlags.filter(Boolean).length / pooledFlags.length : 0),
      totalTasksPassed: passCount,
      totalTasks: suite.tasks.length,
      perTaskPassAt1: Object.fromEntries(allMetrics.map((m) => [m.taskId, m.passAt1])),
      // --- richer measuring-stick fields ---
      n: EVAL_N,
      reportKs: REPORT_KS,
      perTaskPassAtK: Object.fromEntries(allMetrics.map((m) => [m.taskId, m.passAtK])),
      perTaskCI: Object.fromEntries(allMetrics.map((m) => [m.taskId, m.passAtKCI])),
      overallPassAtK,
      overallCI,
      thinkOnlyTotal: allMetrics.reduce((s, m) => s + m.thinkOnlyTurns, 0),
      trialsWithTruncationTotal: allMetrics.reduce((s, m) => s + m.trialsWithTruncation, 0),
      sampling: { temp: TEMP_OVERRIDE, maxTokens: MAX_TOKENS_OVERRIDE },
      ...(BEST_OF_N > 1
        ? {
            bestOfN: BEST_OF_N,
            avgAttemptsUsed:
              allMetrics.reduce((s, m) => s + (m.avgAttemptsUsed ?? 0), 0) /
              Math.max(allMetrics.length, 1),
          }
        : {}),
      // Per-task behavioral fingerprint (P1#4) — cost dims already computed
      // above per task; just reshape into TaskBehavior. repairRate/thinkOnlyRate
      // guard the /0 case (no edits applied / n=0).
      perTaskBehavior: Object.fromEntries(
        allMetrics.map((m): [string, TaskBehavior] => [
          m.taskId,
          {
            passAt1: m.passAt1,
            avgTurns: m.avgTurns,
            avgTokens: m.avgTokens,
            repairRate: m.appliedEdits > 0 ? m.repaired / m.appliedEdits : 0,
            thinkOnlyRate: m.n > 0 ? m.trialsWithTruncation / m.n : 0,
            ...(m.avgAttemptsUsed !== undefined ? { avgAttemptsUsed: m.avgAttemptsUsed } : {}),
          },
        ]),
      ),
    };
    await appendMetricsSnapshot(snapshot);

    await rm(TMP_BASE, { recursive: true, force: true });

    console.log(`\n[run-baseline] Results: ${passCount}/${suite.tasks.length} tasks with pass@1 > 0`);
    console.log(`[run-baseline] Metrics appended to ${METRICS_HISTORY_PATH}`);
    if (SAVE_TRANSCRIPTS && transcriptStore) {
      process.stderr.write(
        `[run-baseline] Saved ${transcriptsSavedTotal} trial transcript(s) to ${TRANSCRIPTS_DIR}\n`,
      );
      // E3-T1: emit the model-vs-harness-rescue split so a headline pass number
      // never silently hides a deterministic-rescue win. Same classifier as
      // scripts/classify-pass-quality.ts (which prints the full per-task table).
      const classified = classifyTranscripts(await transcriptStore.loadAll());
      const passing = classified.length;
      if (passing > 0) {
        const rescued = classified.filter((c) => c.quality === "rescued").length;
        const modelSolved = passing - rescued;
        const pct = (x: number): string => `${Math.round((x / passing) * 100)}%`;
        process.stderr.write(
          `[run-baseline] How solved (${passing} passing trials): ${pct(modelSolved)} model-solved, ` +
            `${pct(rescued)} harness-rescued. Per-task split: bun scripts/classify-pass-quality.ts\n`,
        );
      }
    }
  }
}

main()
  .then(() => {
    // All work is awaited and flushed by here (metrics appended, tmp removed).
    // Force exit: the Ollama HTTP client keeps a keep-alive socket open, which
    // otherwise leaves the event loop alive and hangs the process indefinitely
    // (blocking any driver that pipes/waits on this script, e.g. A/B runners).
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("[run-baseline] ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
