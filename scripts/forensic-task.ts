// Forensic per-task turn dumper. Runs ONE suite task N times through the real
// eval loop and prints every turn — what the model emitted, the apply result,
// and the oracle diagnostic — so the TRUE failure mode is visible (localization
// miss vs edit-apply failure vs think-only truncation vs syntax breakage).
//
// This is a DEBUG tool, not a metric: it bypasses pass@k/CI reporting and shows
// raw transcripts. It found the mri-flags localization wall (the model edits
// every line but the buggy one). Pairs with run-baseline.ts (the measuring
// stick) — use this to understand WHY a task scores what it scores.
//
// Usage:
//   SMALLCODE_SUITE=realrepo FORENSIC_TASK=mri FORENSIC_N=5 \
//   SMALLCODE_MODEL=qwen2.5-coder:3b bun scripts/forensic-task.ts
//
// Env:
//   FORENSIC_TASK   substring of the task id to run (required; first match wins)
//   FORENSIC_N      trials (default 5)
//   SMALLCODE_SUITE suite dir under evals/suites (default realrepo)
//   SMALLCODE_MODEL Ollama model id (default = config.activeModel)
//   SMALLCODE_EVAL_MAX_TURNS  max turns per trial (default 5)
//   FORENSIC_OUT    optional path to dump raw transcripts JSON (skipped if unset)
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { runTask } from "../src/eval/task-runner.ts";
import { loadSuite } from "../src/eval/task-loader.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURES = join(ROOT, "evals/fixtures");
const SUITE_DIR = join(ROOT, "evals/suites", process.env["SMALLCODE_SUITE"] ?? "realrepo");
const NEEDLE = process.env["FORENSIC_TASK"] ?? "";
const N = Number(process.env["FORENSIC_N"] ?? "5");
const MAX_TURNS = Number(process.env["SMALLCODE_EVAL_MAX_TURNS"] ?? "5");

if (!NEEDLE) {
  console.error("FORENSIC_TASK is required (substring of a task id).");
  process.exit(1);
}

const { config, extraModels } = loadConfig();
for (const m of extraModels) defaultRegistry.register(m);
const activeModel = process.env["SMALLCODE_MODEL"] ?? config.activeModel;
const profile = defaultRegistry.get(activeModel);
const provider = createProvider(config.provider, defaultRegistry);
const reasoningHandler = new ReasoningHandler(profile.reasoningTags ?? { open: "<think>", close: "</think>" });

const suite = await loadSuite(SUITE_DIR);
const task = suite.tasks.find((t) => t.id.includes(NEEDLE));
if (!task) {
  console.error(`no task matching "${NEEDLE}" in ${SUITE_DIR}. tasks:`, suite.tasks.map((t) => t.id));
  process.exit(1);
}
console.log(`### FORENSIC task=${task.id} model=${activeModel} N=${N} maxTurns=${MAX_TURNS}\n`);

const agentConfig = {
  repoRoot: ROOT,
  modelId: profile.id,
  maxTurns: MAX_TURNS,
  bestOfN: 1,
  allowedCommands: config.sandbox.allowedCommands,
  requireApproval: false,
  disciplineRules: process.env["SMALLCODE_DISCIPLINE"] !== "0",
  preSolveReflection: process.env["SMALLCODE_PRESOLVE"] === "1",
};
const loopDeps = { provider, profile, reasoningHandler, config: agentConfig };

const result = await runTask(task, {
  trialsPerTask: N,
  reportKs: [1],
  ciSeed: 1,
  fixturesRoot: FIXTURES,
  agentConfig,
  loopDeps,
  bestOfN: 1,
  trialTimeoutMs: 20 * 60 * 1000,
});

const clip = (s: string, n = 1400) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s);

result.trials.forEach((trial, i) => {
  const t = trial.transcript;
  console.log(
    `\n================ TRIAL ${i} passed=${trial.passed} outcome=${t.outcome} turns=${t.turns.length} ================`,
  );
  for (const tn of t.turns) {
    const thinkOnly = tn.toolResults.some((r) => r.error?.includes("think-only"));
    const apply =
      tn.applyResults
        .map((a) => `${a.filePath.split("/").pop()}:${a.status}${a.error ? `(${a.error.slice(0, 60)})` : ""}`)
        .join(", ") || "<none>";
    const diag = tn.diagnostic
      ? `exp=${JSON.stringify(tn.diagnostic.expected)?.slice(0, 80)} act=${JSON.stringify(tn.diagnostic.actual)?.slice(0, 80)} msg=${(tn.diagnostic.message ?? "").slice(0, 100)}`
      : "<none>";
    const tags = `${thinkOnly ? "[THINK-ONLY]" : ""}${tn.answerNow ? "[ANSWER-NOW]" : ""}${tn.redrafted ? "[REDRAFT]" : ""}${tn.reverted ? "[REVERTED]" : ""}`;
    console.log(
      `\n--- turn ${tn.turn} ${tags} reason=${(tn.reasoning ?? "").length}ch ans=${tn.answer.length}ch edits=${tn.editBlocks.length} ---`,
    );
    console.log(`apply: ${apply}`);
    console.log(`diag:  ${diag}`);
    console.log(`ANSWER:\n${clip(tn.answer)}`);
  }
});

const outPath = process.env["FORENSIC_OUT"];
if (outPath) {
  await Bun.write(outPath, JSON.stringify(result.trials.map((t) => t.transcript), null, 2));
  console.log(`\n### raw transcripts → ${outPath}`);
}
console.log(`\n### passed ${result.trials.filter((t) => t.passed).length}/${result.trials.length}`);
process.exit(0);
