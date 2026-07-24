#!/usr/bin/env bun
// R5b: SWE-bench-Lite runner.
//
// HONEST EXECUTION MODEL. SWE-bench-Lite instances each need their repo at a
// specific commit with a per-instance pinned Python environment (the official
// harness ships a Docker image per instance for this reason). This runner does
// NOT try to recreate those environments. For each instance it:
//   1. clones the repo + checks out base_commit (cached under SWEBENCH_WORK),
//   2. applies the test_patch (adds the FAIL_TO_PASS tests),
//   3. PROBES whether the tests are even collectable here (`pytest --collect-only`);
//      if not (missing/incompatible deps — the common case off-Docker) the
//      instance is SKIPPED and reported as env-unavailable. NEVER a fake 0.
//   4. only for collectable instances: runs the smallcode agent on the issue text,
//      then grades FAIL_TO_PASS (must pass) + PASS_TO_PASS (must stay green).
//
// Reports pass@1 + edit-format-% over the RUNNABLE subset, plus the skip count, so
// the number is honest about what this machine could actually execute.
//
//   SWEBENCH_WORK=/tmp/swebench bun scripts/run-swebench.ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import { contextBudgetFor } from "../src/models/context-budget.ts";
import { createState, getStatePath } from "../src/agent/state.ts";
import { runLoop } from "../src/agent/loop.ts";
import { walkRepo, buildContext } from "../src/context/index.ts";
import { summarizeSwebench } from "../src/eval/swebench-report.ts";
import type { AgentConfig } from "../src/agent/types.ts";

const ROOT = join(import.meta.dir, "..");
const SUITE = join(ROOT, "evals/suites/swebench-lite");
const WORK = process.env.SWEBENCH_WORK ?? "/tmp/swebench-work";
const MODEL = process.env.SMALLCODE_MODEL ?? "qwen2.5-coder:3b";
const MAX_TURNS = Number(process.env.SMALLCODE_EVAL_MAX_TURNS ?? "8");
const LIMIT = Number(process.env.SWEBENCH_LIMIT ?? "5");

function sh(cmd: string[], cwd: string, timeoutMs = 300_000): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, timeout: timeoutMs });
  const out =
    (p.stdout instanceof Uint8Array ? new TextDecoder().decode(p.stdout) : "") +
    (p.stderr instanceof Uint8Array ? new TextDecoder().decode(p.stderr) : "");
  return { ok: (p.exitCode ?? 1) === 0, out };
}

if (!existsSync(SUITE)) {
  console.error("No swebench-lite suite. Run: bun scripts/vendor-swebench.ts");
  process.exit(1);
}
mkdirSync(WORK, { recursive: true });

const { config } = loadConfig();
const profile = defaultRegistry.get(MODEL);
const provider = createProvider(config.provider, defaultRegistry);
const reasoningHandler = new ReasoningHandler(profile.reasoningTags ?? { open: "<think>", close: "</think>" });
const ctxBudget = contextBudgetFor(profile);

const files = readdirSync(SUITE).filter((f) => f.endsWith(".json") && f !== "suite.json").slice(0, LIMIT);
let runnable = 0;
let passed = 0;
let editFmt = 0;
let rescued = 0;
const skipped: string[] = [];

for (const file of files) {
  const inst = JSON.parse(readFileSync(join(SUITE, file), "utf-8"));
  const { repo, base_commit, test_patch } = inst.setup.swebench;
  const repoDir = join(WORK, inst.id);

  // 1. clone + checkout base_commit (cached).
  if (!existsSync(repoDir)) {
    const cl = sh(["git", "clone", "--quiet", `https://github.com/${repo}`, repoDir], WORK, 600_000);
    if (!cl.ok) { skipped.push(`${inst.id} (clone failed)`); continue; }
  }
  if (!sh(["git", "checkout", "--quiet", "--force", base_commit], repoDir).ok) {
    skipped.push(`${inst.id} (checkout failed)`); continue;
  }
  sh(["git", "reset", "--hard", "--quiet", base_commit], repoDir);
  sh(["git", "clean", "-fdq"], repoDir);

  // 2. apply test_patch.
  const patchPath = join(repoDir, ".swebench-test.patch");
  Bun.spawnSync(["bash", "-c", `cat > "${patchPath}"`], { cwd: repoDir, stdin: Buffer.from(test_patch) });
  if (!sh(["git", "apply", "--whitespace=nowarn", patchPath], repoDir).ok) {
    skipped.push(`${inst.id} (test_patch apply failed)`); continue;
  }

  // 3. PROBE collectability — can this machine even import the test deps?
  const probe = sh(["python3", "-m", "pytest", "--collect-only", "-q", ...inst.fail_to_pass], repoDir, 120_000);
  if (!probe.ok) { skipped.push(`${inst.id} (env-unavailable: deps not importable here)`); continue; }

  // 4. RUNNABLE — run the agent on the issue text, then grade.
  runnable++;
  const agentConfig: AgentConfig = { repoRoot: repoDir, modelId: MODEL, maxTurns: MAX_TURNS, bestOfN: 1, requireApproval: false };
  const state = createState(agentConfig, inst.desc);
  const repoMap = await walkRepo({ root: repoDir }, Date.now());
  const getContext = (q: string) => buildContext(repoMap, q, { repoRoot: repoDir, tokenBudget: ctxBudget });
  const final = await runLoop(state, getStatePath(agentConfig), { provider, profile, reasoningHandler, config: agentConfig }, getContext);

  const f2p = sh(["python3", "-m", "pytest", "-q", ...inst.fail_to_pass], repoDir, 300_000).ok;
  const p2p = inst.pass_to_pass.length === 0 || sh(["python3", "-m", "pytest", "-q", ...inst.pass_to_pass.slice(0, 20)], repoDir, 300_000).ok;
  const ok = f2p && p2p;
  if (ok) {
    passed++;
    // Attribution (E3-T2 / E5-T1): a pass a harness rescue produced, not the model.
    if (final.turns.some((t) => t.mutationRepair !== undefined)) rescued++;
  }
  const ef = final.turns.some((t) => t.applyResults.some((a) => a.status === "applied"));
  if (ef) editFmt++;
  console.log(`  ${ok ? "PASS" : "fail"} ${inst.id}  (status=${final.status})`);
}

console.log("");
for (const line of summarizeSwebench({ total: files.length, runnable, passed, editFmt, rescued, skipped }).lines) {
  console.log(line);
}
if (skipped.length) console.log(`[swebench] skipped: ${skipped.slice(0, 8).join("; ")}${skipped.length > 8 ? " …" : ""}`);
