#!/usr/bin/env bun
/**
 * Debug a single capability eval task end-to-end without cleanup.
 *
 * Usage:
 *   bun scripts/debug-task.ts cap-group-by_1
 *
 * Dumps:
 *   - Final agent status + turn count
 *   - Full rawResponse for every turn
 *   - Final contents of all .ts/.js source files in the trial dir
 *   - Grader verdicts
 *   - Trial dir path (for manual inspection)
 */

import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { loadSuite } from "../src/eval/task-loader.ts";
import { runGrader } from "../src/eval/graders/index.ts";
import { createTrialEnv } from "../src/eval/trial-env.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import { runLoop } from "../src/agent/loop.ts";
import { createState, getStatePath } from "../src/agent/state.ts";
import { estimateTokens } from "../src/context/tokens.ts";
import type { ContextBundle, ContextChunk } from "../src/context/types.ts";
import type { Transcript } from "../src/eval/types.ts";

// ---------------------------------------------------------------------------
// Config (mirrors run-baseline)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SUITE_NAME = process.env["SMALLCODE_SUITE"] ?? "capability";
const SUITE_DIR = SUITE_NAME.includes("/")
  ? resolve(PROJECT_ROOT, SUITE_NAME)
  : join(PROJECT_ROOT, "evals", "suites", SUITE_NAME);
const FIXTURES_DIR = join(PROJECT_ROOT, "evals", "fixtures");
const EVAL_MAX_TURNS = Number(process.env.SMALLCODE_EVAL_MAX_TURNS ?? "5");

// ---------------------------------------------------------------------------
// buildTrialContext — copy from task-runner (not exported)
// ---------------------------------------------------------------------------

async function buildTrialContext(trialDir: string, query: string): Promise<ContextBundle> {
  const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]);
  const SKIP_DIRS = new Set(["node_modules", ".git", ".smallcode"]);

  const chunks: ContextChunk[] = [];
  let totalTokens = 0;
  const TOKEN_BUDGET = 8_000;

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir, { encoding: "utf-8" });
    } catch {
      return;
    }
    for (const name of entries) {
      const absPath = join(dir, name);
      let isDir = false;
      try {
        const s = await lstat(absPath);
        isDir = s.isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(name)) await walk(absPath);
        continue;
      }
      const ext = name.slice(name.lastIndexOf("."));
      if (!SOURCE_EXTS.has(ext)) continue;
      const relPath = relative(trialDir, absPath);
      try {
        const content = await readFile(absPath, { encoding: "utf-8" });
        const lines = content.split("\n");
        const tokens = estimateTokens(content);
        if (totalTokens + tokens > TOKEN_BUDGET) continue;
        totalTokens += tokens;
        chunks.push({
          filePath: relPath,
          content,
          startLine: 1,
          endLine: lines.length,
          estimatedTokens: tokens,
        });
      } catch {
        // skip unreadable
      }
    }
  }

  await walk(trialDir);
  return { chunks, totalTokens, tokenBudget: TOKEN_BUDGET, truncated: false, query };
}

// ---------------------------------------------------------------------------
// Walk and print final source files
// ---------------------------------------------------------------------------

async function printSourceFiles(trialDir: string): Promise<void> {
  const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]);
  const SKIP_DIRS = new Set(["node_modules", ".git", ".smallcode"]);

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir, { encoding: "utf-8" });
    } catch {
      return;
    }
    for (const name of entries) {
      const absPath = join(dir, name);
      let isDir = false;
      try {
        const s = await lstat(absPath);
        isDir = s.isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(name)) await walk(absPath);
        continue;
      }
      const ext = name.slice(name.lastIndexOf("."));
      if (!SOURCE_EXTS.has(ext)) continue;
      const relPath = relative(trialDir, absPath);
      try {
        const content = await readFile(absPath, { encoding: "utf-8" });
        console.log(`\n${"=".repeat(72)}`);
        console.log(`FILE: ${relPath}`);
        console.log("=".repeat(72));
        console.log(content);
      } catch {
        console.log(`  [could not read ${relPath}]`);
      }
    }
  }

  await walk(trialDir);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error("Usage: bun scripts/debug-task.ts <task-id>");
    process.exit(1);
  }

  // Load suite and find task
  const suite = await loadSuite(SUITE_DIR);
  const task = suite.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task "${taskId}" not found in suite. Available tasks:`);
    for (const t of suite.tasks) console.error(`  ${t.id}`);
    process.exit(1);
  }

  console.log(`\n[debug-task] Task: ${task.id}`);
  console.log(`[debug-task] Desc: ${task.desc}`);

  // Build provider/config (mirrors liveRunTask in run-baseline)
  const { config, extraModels } = loadConfig();
  for (const m of extraModels) defaultRegistry.register(m);

  const profile = defaultRegistry.get(config.activeModel);
  const provider = createProvider(config.provider, defaultRegistry);
  const reasoningHandler = new ReasoningHandler(
    profile.reasoningTags ?? { open: "<think>", close: "</think>" },
  );

  const agentConfig = {
    repoRoot: PROJECT_ROOT, // overridden per trial below
    modelId: profile.id,
    maxTurns: EVAL_MAX_TURNS,
    bestOfN: 1,
    allowedCommands: config.sandbox.allowedCommands,
    requireApproval: false,
  };

  const loopDeps = {
    provider,
    profile,
    reasoningHandler,
    config: agentConfig,
  };

  // Create trial env — intentionally NOT calling cleanup
  const trialStartedAt = Date.now();
  const trialEnv = await createTrialEnv(task, FIXTURES_DIR);

  console.log(`[debug-task] Trial dir: ${trialEnv.dir}`);

  const trialConfig = {
    ...agentConfig,
    repoRoot: trialEnv.dir,
    statePath: join(trialEnv.dir, ".smallcode", "state.json"),
  };

  const state = createState(trialConfig, task.desc);
  const statePath = getStatePath(trialConfig);

  const trialDeps = {
    ...loopDeps,
    config: trialConfig,
  };

  // Run the agent loop (no timeout wrapper — this is a debug script)
  console.log(`\n[debug-task] Running agent loop (maxTurns=${EVAL_MAX_TURNS})...`);
  const finalState = await runLoop(
    state,
    statePath,
    trialDeps,
    async (goal: string): Promise<ContextBundle> => buildTrialContext(trialEnv.dir, goal),
  );

  const trialFinishedAt = Date.now();

  // ---------------------------------------------------------------------------
  // 1. Status summary
  // ---------------------------------------------------------------------------
  console.log(`\n${"#".repeat(72)}`);
  console.log(`AGENT STATUS: ${finalState.status}`);
  console.log(`TURNS:        ${finalState.turns.length}`);
  console.log(`ELAPSED:      ${Math.round((trialFinishedAt - trialStartedAt) / 1000)}s`);
  console.log("#".repeat(72));

  // ---------------------------------------------------------------------------
  // 2. Per-turn raw model output
  // ---------------------------------------------------------------------------
  console.log(`\n${"#".repeat(72)}`);
  console.log("TURN-BY-TURN RAW MODEL OUTPUT");
  console.log("#".repeat(72));

  for (const turn of finalState.turns) {
    console.log(`\n--- Turn ${turn.turn} (goal: ${turn.goalId}) ---`);
    console.log(`  toolCalls: ${turn.toolCalls.map((tc) => tc.name).join(", ") || "(none)"}`);
    console.log(`  tokens: prompt=${turn.promptTokens} completion=${turn.completionTokens}`);
    console.log("\n[rawResponse]:");
    console.log(turn.rawResponse);
    if (turn.reasoning) {
      console.log("\n[reasoning]:");
      console.log(turn.reasoning);
    }
    console.log("\n[applyResults]:");
    for (const ar of turn.applyResults) {
      console.log(`  ${JSON.stringify(ar)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Final file contents
  // ---------------------------------------------------------------------------
  console.log(`\n${"#".repeat(72)}`);
  console.log("FINAL SOURCE FILE CONTENTS");
  console.log("#".repeat(72));
  await printSourceFiles(trialEnv.dir);

  // ---------------------------------------------------------------------------
  // 4. Grader results
  // ---------------------------------------------------------------------------
  console.log(`\n${"#".repeat(72)}`);
  console.log("GRADER RESULTS");
  console.log("#".repeat(72));

  const transcript: Transcript = {
    id: randomUUID(),
    sessionId: finalState.sessionId,
    taskId: task.id,
    trialIndex: 0,
    modelId: finalState.modelId,
    turns: finalState.turns,
    outcome:
      finalState.status === "done"
        ? "passed"
        : finalState.status === "failed"
          ? "failed"
          : finalState.status === "max_turns"
            ? "timeout"
            : "error",
    startedAt: trialStartedAt,
    finishedAt: trialFinishedAt,
  };

  for (const graderConfig of task.graders) {
    try {
      const result = await runGrader(graderConfig, trialEnv.dir, transcript);
      console.log(`\nGrader [${result.type}]`);
      console.log(`  verdict: ${result.verdict}  score: ${result.score}`);
      console.log(`  output: ${result.output}`);
      if (result.details) {
        console.log(`  details: ${JSON.stringify(result.details, null, 2)}`);
      }
    } catch (err) {
      console.log(`\nGrader [${graderConfig.type}] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Trial dir reminder
  // ---------------------------------------------------------------------------
  console.log(`\n${"#".repeat(72)}`);
  console.log(`TRIAL DIR (not cleaned up): ${trialEnv.dir}`);
  console.log("#".repeat(72));
}

main().catch((err: unknown) => {
  console.error("[debug-task] ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
