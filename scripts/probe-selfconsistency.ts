#!/usr/bin/env bun
// Oracle-free self-consistency PROBE (low expectation, per the analysis).
//
// Core question: with NO test oracle, does picking the MAJORITY (most-agreed)
// candidate among N independent attempts select a correct solution more often
// than a random candidate? If consensus predicts correctness, majority-cluster
// pass-rate >> mean candidate pass-rate. If not (the prediction — a 3B's wrong
// answers often share a dominant trap), it's no better than random.
//
// Method: run N independent agent attempts (no short-circuit), read each
// attempt's final edited target file, cluster by NORMALIZED content (comments +
// whitespace stripped), then grade every attempt with the hidden oracle ONLY for
// measurement. Reports majority-cluster pass-rate vs mean vs any-pass.
//
//   SC_TASKS=realrepo-dset-deepset_1,polyglot-binary SC_N=8 SC_SUITE=realrepo bun scripts/probe-selfconsistency.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import { contextBudgetFor } from "../src/models/context-budget.ts";
import { createState, getStatePath } from "../src/agent/state.ts";
import { runBestOfNLoop } from "../src/agent/bestofn-loop.ts";
import { loadSuite } from "../src/eval/task-loader.ts";
import { createTrialEnv } from "../src/eval/trial-env.ts";
import { buildTrialContext } from "../src/eval/task-runner.ts";
import { runGrader } from "../src/eval/graders/index.ts";
import type { AgentConfig } from "../src/agent/types.ts";

const ROOT = join(import.meta.dir, "..");
const FIX = join(ROOT, "evals/fixtures");
const SUITE = process.env.SC_SUITE ?? "realrepo";
const N = Number(process.env.SC_N ?? "8");
const MODEL = process.env.SMALLCODE_MODEL ?? "qwen2.5-coder:3b";
const TASK_FILTER = (process.env.SC_TASKS ?? "dset,regexparam,klona-array").split(",").map((s) => s.trim());

// The file the solution overlay edits = the target to cluster on.
function solutionTarget(id: string): string | null {
  const sol = join(FIX, `${id}-solution`);
  const out: string[] = [];
  function walk(d: string, rel: string) {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const n of entries) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(d, n)).isDirectory()) walk(join(d, n), r);
      else out.push(r);
    }
  }
  walk(sol, "");
  return out[0] ?? null;
}

function normalize(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const { config, extraModels } = loadConfig();
const registry = defaultRegistry;
const profile = registry.get(MODEL);
const provider = createProvider(config.provider, registry);
const reasoningHandler = new ReasoningHandler(profile.reasoningTags ?? { open: "<think>", close: "</think>" });
const ctxBudget = contextBudgetFor(profile);

const suite = await loadSuite(join(ROOT, "evals/suites", SUITE));
const tasks = suite.tasks.filter((t) => TASK_FILTER.some((f) => t.id.includes(f)));
console.log(`[selfconsistency] ${tasks.length} task(s), N=${N}, model=${MODEL}\n`);

const stubTranscript = { id: "p", sessionId: "p", taskId: "p", trialIndex: 0, modelId: MODEL, turns: [], outcome: "failed" as const, startedAt: 0, finishedAt: 1 };

for (const task of tasks) {
  const target = solutionTarget(task.id);
  if (!target) { console.log(`  ${task.id}: no solution target, skip`); continue; }

  const dirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  const agentConfig: AgentConfig = { repoRoot: ROOT, modelId: MODEL, maxTurns: 6, bestOfN: 1, requireApproval: false };

  await runBestOfNLoop({
    n: N,
    deps: { provider, profile, reasoningHandler, config: agentConfig },
    setup: async (attempt) => {
      const env = await createTrialEnv(task, FIX);
      cleanups.push(env.cleanup);
      dirs[attempt] = env.dir;
      const tc: AgentConfig = { ...agentConfig, repoRoot: env.dir, statePath: join(env.dir, ".smallcode", "state.json") };
      const state = createState(tc, task.desc);
      return {
        state,
        statePath: getStatePath(tc),
        getContext: (q: string) => buildTrialContext(env.dir, q, ctxBudget),
      };
    },
    verify: async () => false, // never short-circuit — run all N
  });

  // Grade + read final code per attempt.
  const grader = task.graders[0]!;
  const passed: boolean[] = [];
  const codes: string[] = [];
  for (let i = 0; i < N; i++) {
    const dir = dirs[i];
    if (!dir) { passed.push(false); codes.push(`<no-dir-${i}>`); continue; }
    const g = await runGrader(grader, dir, stubTranscript);
    passed.push(g.verdict === "pass");
    try { codes.push(normalize(readFileSync(join(dir, target), "utf-8"))); } catch { codes.push(`<unread-${i}>`); }
  }
  for (const c of cleanups) await c().catch(() => {});

  // Cluster by normalized code.
  const clusters = new Map<string, number[]>();
  codes.forEach((c, i) => { (clusters.get(c) ?? clusters.set(c, []).get(c)!).push(i); });
  const sorted = [...clusters.values()].sort((a, b) => b.length - a.length);
  const majority = sorted[0] ?? [];
  const meanPass = passed.filter(Boolean).length / N;
  const majPass = majority.length ? majority.filter((i) => passed[i]).length / majority.length : 0;
  const anyPass = passed.some(Boolean);
  console.log(
    `  ${task.id.padEnd(30)} clusters=${sorted.length}/${N} majority=${majority.length}` +
      ` | majority-pass=${majPass.toFixed(2)} mean-pass=${meanPass.toFixed(2)} any-pass=${anyPass ? 1 : 0}` +
      `  ${majPass > meanPass + 1e-9 ? "[consensus HELPS]" : majPass < meanPass - 1e-9 ? "[consensus HURTS]" : "[no signal]"}`,
  );
}
console.log("\nIf majority-pass > mean-pass across tasks → consensus predicts correctness (oracle-free selection works).");
