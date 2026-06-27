#!/usr/bin/env bun
/**
 * GEPA cheap probe (throwaway, not shipped).
 *
 * Runs ONE eval task n times with a given system prompt (default OR a mutated
 * variant loaded from a file), reports pass@1, and dumps FAILING transcripts so
 * a frontier reflector (Claude, by hand) can diagnose the failure pattern and
 * propose a mutated system prompt. Then rerun with the mutation to measure delta.
 *
 * Usage:
 *   SMALLCODE_SUITE=evals/suites/edit-reliability bun scripts/gepa-probe.ts <task-id> <n> [mutated-system-file]
 *
 * Output: per-trial pass/fail + pass@1; writes failing raw responses to
 *   /tmp/gepa-probe-<task>-<arm>.txt for inspection.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { loadSuite } from "../src/eval/task-loader.ts";
import { runGrader } from "../src/eval/graders/index.ts";
import { createTrialEnv } from "../src/eval/trial-env.ts";
import { buildTrialContext } from "../src/eval/task-runner.ts";
import { contextBudgetFor } from "../src/models/context-budget.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import { runLoop } from "../src/agent/loop.ts";
import { createState, getStatePath } from "../src/agent/state.ts";
import { defaultPromptSet } from "../src/agent/prompt-set.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { Transcript } from "../src/eval/types.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SUITE_NAME = process.env["SMALLCODE_SUITE"] ?? "capability";
const SUITE_DIR = SUITE_NAME.includes("/")
  ? resolve(PROJECT_ROOT, SUITE_NAME)
  : join(PROJECT_ROOT, "evals", "suites", SUITE_NAME);
const FIXTURES_DIR = join(PROJECT_ROOT, "evals", "fixtures");
const EVAL_MAX_TURNS = Number(process.env.SMALLCODE_EVAL_MAX_TURNS ?? "5");

async function main(): Promise<void> {
  const taskId = process.argv[2];
  const n = Number(process.argv[3] ?? "6");
  const mutatedFile = process.argv[4];
  if (!taskId) {
    console.error("Usage: bun scripts/gepa-probe.ts <task-id> <n> [mutated-system-file]");
    process.exit(1);
  }

  const arm = mutatedFile ? "mutated" : "base";
  const suite = await loadSuite(SUITE_DIR);
  const task = suite.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task "${taskId}" not found. Available:`);
    for (const t of suite.tasks) console.error(`  ${t.id}`);
    process.exit(1);
  }

  const { config, extraModels } = loadConfig();
  for (const m of extraModels) defaultRegistry.register(m);
  const activeModel = process.env.SMALLCODE_MODEL || config.activeModel;
  const profile = defaultRegistry.get(activeModel);
  const provider = createProvider(config.provider, defaultRegistry);
  const reasoningHandler = new ReasoningHandler(
    profile.reasoningTags ?? { open: "<think>", close: "</think>" },
  );

  // Build the PromptSet for this arm: default, or default with system swapped.
  const ps = defaultPromptSet();
  if (mutatedFile) {
    ps.system = await Bun.file(mutatedFile).text();
  }

  const agentConfig = {
    repoRoot: PROJECT_ROOT,
    modelId: profile.id,
    maxTurns: EVAL_MAX_TURNS,
    bestOfN: 1,
    allowedCommands: config.sandbox.allowedCommands,
    requireApproval: false,
    promptSet: ps,
  };
  const loopDeps = { provider, profile, reasoningHandler, config: agentConfig };

  console.log(`[gepa-probe] task=${taskId} arm=${arm} model=${profile.id} n=${n}`);
  console.log(`[gepa-probe] system prompt: ${ps.system.length} chars`);

  const failDump: string[] = [];
  let passCount = 0;
  for (let i = 0; i < n; i++) {
    const trialEnv = await createTrialEnv(task, FIXTURES_DIR);
    const trialConfig = {
      ...agentConfig,
      repoRoot: trialEnv.dir,
      statePath: join(trialEnv.dir, ".smallcode", "state.json"),
    };
    const state = createState(trialConfig, task.desc);
    const statePath = getStatePath(trialConfig);
    const trialDeps = { ...loopDeps, config: trialConfig };
    const startedAt = Date.now();
    const finalState = await runLoop(
      state,
      statePath,
      trialDeps,
      async (goal: string): Promise<ContextBundle> =>
        buildTrialContext(trialEnv.dir, goal, contextBudgetFor(profile)),
    );
    const transcript: Transcript = {
      id: crypto.randomUUID(),
      sessionId: finalState.sessionId,
      taskId: task.id,
      trialIndex: i,
      modelId: finalState.modelId,
      turns: finalState.turns,
      outcome: finalState.status === "done" ? "passed" : "failed",
      startedAt,
      finishedAt: Date.now(),
    };
    let passed = true;
    let graderOut = "";
    for (const gc of task.graders) {
      const r = await runGrader(gc, trialEnv.dir, transcript);
      if (r.verdict !== "pass") passed = false;
      graderOut += `[${r.type}:${r.verdict} ${r.score}] ${r.output?.slice(0, 200) ?? ""}\n`;
    }
    if (passed) passCount++;
    console.log(`  trial ${i + 1}/${n}: ${passed ? "PASS" : "FAIL"} status=${finalState.status} turns=${finalState.turns.length}`);
    if (!passed) {
      const raw = finalState.turns.map((t, ti) => `--- turn ${ti} (${t.toolCalls.map((c) => c.name).join(",")}) ---\n${t.rawResponse}`).join("\n\n");
      failDump.push(`========== TRIAL ${i} (status=${finalState.status}) ==========\nGRADER:\n${graderOut}\nRAW:\n${raw}`);
    }
    await trialEnv.cleanup();
  }

  const passAt1 = passCount / n;
  console.log(`\n[gepa-probe] ${arm} pass@1 = ${passCount}/${n} = ${passAt1.toFixed(2)}`);
  if (failDump.length) {
    const dumpPath = `/tmp/gepa-probe-${taskId}-${arm}.txt`;
    writeFileSync(dumpPath, failDump.join("\n\n"));
    console.log(`[gepa-probe] failing transcripts → ${dumpPath}`);
  }
}

main().catch((err: unknown) => {
  console.error("[gepa-probe] ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
