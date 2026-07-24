#!/usr/bin/env bun
// E3-T3 — dogfood harness over smallcode's OWN git history.
//
// For each real past bug-fix commit: create a git worktree AT that commit (so its
// own diff reverse-applies cleanly), reverse-apply ONLY its SOURCE hunks to
// re-introduce the bug (keeping the guarding TEST the commit added), confirm the
// test now goes RED, then run the CURRENT smallcode agent to re-fix it, graded by
// smallcode's own `bun test`. Reports pass + model-vs-rescue attribution + a
// single-site/cross-file label.
//
//   bun scripts/dogfood-history.ts                 # setup-only: verify each bug reproduces
//   DOGFOOD_AGENT=1 SMALLCODE_MODEL=qwen2.5-coder:7b bun scripts/dogfood-history.ts   # + run the agent
//   DOGFOOD_LIMIT=1 ...                            # bound the number of commits
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getStatePath } from "../src/agent/state.ts";
import { runLoop } from "../src/agent/loop.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import { loadConfig } from "../src/config/loader.ts";
import { buildContext, walkRepo } from "../src/context/index.ts";
import { contextBudgetFor } from "../src/models/context-budget.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import {
  classifyCommitFiles,
  type DogfoodResult,
  labelChange,
  summarizeDogfood,
} from "../src/eval/dogfood-history.ts";

const ROOT = join(import.meta.dir, "..");
const SUITE = join(ROOT, "evals/suites/dogfood/commits.json");
const RUN_AGENT = process.env["DOGFOOD_AGENT"] === "1";
const MODEL = process.env["SMALLCODE_MODEL"] ?? "qwen2.5-coder:7b";
const LIMIT = Number(process.env["DOGFOOD_LIMIT"] ?? "99");
const MAX_TURNS = Number(process.env["SMALLCODE_EVAL_MAX_TURNS"] ?? "6");

function sh(cmd: string[], cwd: string, stdin?: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, ...(stdin ? { stdin: Buffer.from(stdin) } : {}), timeout: 300_000 });
  const out =
    (p.stdout instanceof Uint8Array ? new TextDecoder().decode(p.stdout) : "") +
    (p.stderr instanceof Uint8Array ? new TextDecoder().decode(p.stderr) : "");
  return { ok: (p.exitCode ?? 1) === 0, out };
}

/** git show of a commit restricted to specific paths (the src-only reverse patch). */
function diffForPaths(commit: string, paths: string[]): string {
  return sh(["git", "show", "--format=", commit, "--", ...paths], ROOT).out;
}

async function main(): Promise<void> {
  if (!existsSync(SUITE)) {
    console.error(`No dogfood suite at ${SUITE}`);
    process.exit(1);
  }
  const suite = JSON.parse(readFileSync(SUITE, "utf-8")) as { commits: Array<{ commit: string; note: string }> };
  const commits = suite.commits.slice(0, LIMIT);

  const results: DogfoodResult[] = [];
  for (const { commit } of commits) {
    // Files this commit changed.
    const nameOnly = sh(["git", "show", "--name-only", "--format=", commit], ROOT);
    if (!nameOnly.ok) {
      results.push({ commit, label: "single-site", bugReproduced: false, skipped: "commit not found" });
      continue;
    }
    const files = nameOnly.out.split("\n").map((s) => s.trim()).filter(Boolean);
    const { src, test } = classifyCommitFiles(files);
    const label = labelChange(src);
    if (src.length === 0 || test.length === 0) {
      results.push({ commit, label, bugReproduced: false, skipped: "no clean src+test split" });
      continue;
    }

    // Worktree AT the commit (so its own src diff reverse-applies cleanly).
    const wt = mkdtempSync(join(tmpdir(), `dogfood-${commit}-`));
    rmSync(wt, { recursive: true, force: true });
    const add = sh(["git", "worktree", "add", "--quiet", "--detach", wt, commit], ROOT);
    if (!add.ok) {
      results.push({ commit, label, bugReproduced: false, skipped: `worktree add failed: ${add.out.trim().slice(0, 80)}` });
      continue;
    }
    try {
      // Re-introduce the bug: reverse-apply the SOURCE hunks only. The test stays.
      const rev = sh(["git", "apply", "-R", "--whitespace=nowarn"], wt, diffForPaths(commit, src));
      if (!rev.ok) {
        results.push({ commit, label, bugReproduced: false, skipped: "src reverse-apply failed" });
        continue;
      }
      sh(["bun", "install", "--frozen-lockfile"], wt);

      // Confirm the guarding test now goes RED (the bug is really back).
      const redBefore = !sh(["bun", "test", ...test], wt).ok;
      if (!redBefore) {
        // The kept test didn't fail on the reverted src → not a valid dogfood setup.
        results.push({ commit, label, bugReproduced: false, skipped: "reverting src did not turn the test red" });
        continue;
      }

      if (!RUN_AGENT) {
        results.push({ commit, label, bugReproduced: true });
        continue;
      }

      // Run the CURRENT agent to re-fix, graded by the guarding test.
      const { config } = loadConfig();
      const profile = defaultRegistry.get(MODEL);
      const provider = createProvider(config.provider, defaultRegistry);
      const reasoningHandler = new ReasoningHandler(profile.reasoningTags ?? { open: "<think>", close: "</think>" });
      const agentConfig: AgentConfig = { repoRoot: wt, modelId: MODEL, maxTurns: MAX_TURNS, bestOfN: 1, requireApproval: false };
      const task = `A test is failing after a regression. Fix the source so the failing test passes: ${test.join(", ")}. Do not edit the test.`;
      const state = createState(agentConfig, task);
      const repoMap = await walkRepo({ root: wt }, Date.now());
      const getContext = (q: string) => buildContext(repoMap, q, { repoRoot: wt, tokenBudget: contextBudgetFor(profile) });
      const final = await runLoop(state, getStatePath(agentConfig), { provider, profile, reasoningHandler, config: agentConfig }, getContext);

      const solved = sh(["bun", "test", ...test], wt).ok;
      const rescued = final.turns.some((t) => t.mutationRepair !== undefined);
      results.push({ commit, label, bugReproduced: true, solved, rescued: solved && rescued });
      console.log(`  ${solved ? "PASS" : "fail"} ${commit} (${label})`);
    } finally {
      sh(["git", "worktree", "remove", "--force", wt], ROOT);
    }
  }

  console.log("");
  for (const line of summarizeDogfood(results)) console.log(line);
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("[dogfood] ERROR:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
