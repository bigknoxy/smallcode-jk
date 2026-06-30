import { resolve } from "node:path";
import { runBestOfNLoop } from "../../agent/bestofn-loop.ts";
import { buildEscalationLadder } from "../../agent/escalation.ts";
import { runLoop } from "../../agent/loop.ts";
import { renderConfidence } from "../../verify/confidence.ts";
import { captureTestBaseline, runTieredOracle } from "../../verify/oracle.ts";
import { planTask } from "../../agent/planner.ts";
import { createState, getStatePath } from "../../agent/state.ts";
import type { AgentConfig, AgentState } from "../../agent/types.ts";
import { loadConfig } from "../../config/loader.ts";
import { buildContext, walkRepo } from "../../context/index.ts";
import type { ContextBundle } from "../../context/types.ts";
import { contextBudgetFor } from "../../models/context-budget.ts";
import { ModelRegistry } from "../../models/registry.ts";
import { createProvider } from "../../provider/factory.ts";
import { ReasoningHandler } from "../../reasoning/handler.ts";
import type { ParsedArgs } from "../args.ts";
import { ProgressDisplay } from "../progress.ts";

// ---------------------------------------------------------------------------
// classifyCompletion — pure helper; no I/O; exported for unit tests.
// ---------------------------------------------------------------------------

export interface CompletionClassification {
  /** True only when the run genuinely succeeded: tests oracle-verified green. */
  ok: boolean;
  tone: "success" | "warn" | "error";
  message: string;
}

/**
 * Classify a finished agent run into a user-facing outcome.
 *
 * Rules:
 * - status "done" + verified true  → success (oracle confirmed tests green)
 * - status "done" + verified falsy → warn (model called finish() without verified tests)
 * - status "max_turns"             → error (hit turn cap without solving)
 * - status "failed"                → error (loop explicitly failed)
 * - status "abandoned" / "running" / anything else → error (unexpected)
 */
export function classifyCompletion(
  finalState: Pick<AgentState, "status" | "verified">,
  statePath: string,
): CompletionClassification {
  const { status, verified } = finalState;

  if (status === "done" && verified === true) {
    return {
      ok: true,
      tone: "success",
      message: "Done — tests verified passing",
    };
  }

  if (status === "done") {
    // Model called finish() but oracle never confirmed green.
    return {
      ok: false,
      tone: "warn",
      message: `Finished, but tests are NOT verified passing — review ${statePath}`,
    };
  }

  if (status === "max_turns") {
    return {
      ok: false,
      tone: "error",
      message: `Hit max turns without solving — check ${statePath}`,
    };
  }

  if (status === "failed") {
    return {
      ok: false,
      tone: "error",
      message: `Agent failed — check state at ${statePath}`,
    };
  }

  // "abandoned", "running", or any future status not handled above.
  return {
    ok: false,
    tone: "error",
    message: `Run ended with unexpected status "${status}" — check ${statePath}`,
  };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  if (typeof val === "string") return val;
  return undefined;
}

function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const val = flags[key];
  if (typeof val === "string") {
    const n = Number(val);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  const out =
    (p.stdout instanceof Uint8Array ? new TextDecoder().decode(p.stdout) : "") +
    (p.stderr instanceof Uint8Array ? new TextDecoder().decode(p.stderr) : "");
  return { ok: (p.exitCode ?? 1) === 0, out };
}

/**
 * Run-level Best-of-N on a LIVE user repo needs a clean per-attempt rollback so a
 * losing attempt's edits never leak into the next (or survive at the end). We use
 * `git reset --hard` + `git clean -fd` between attempts — which is only safe when
 * the repo is a git checkout with NO uncommitted work to clobber. Returns an error
 * string to print (and abort) when the preconditions aren't met, or null when OK.
 */
function checkBonGitPreconditions(repoRoot: string): string | null {
  if (!git(["rev-parse", "--git-dir"], repoRoot).ok) {
    return "run-level Best-of-N (best-of-n > 1) needs a git repository so each attempt can roll back cleanly. Run `git init && git add -A && git commit -m init`, or use --best-of-n 1.";
  }
  const status = git(["status", "--porcelain"], repoRoot);
  if (status.out.trim().length > 0) {
    return "run-level Best-of-N needs a CLEAN git working tree — it resets the tree between attempts and would discard uncommitted work. Commit or stash your changes (`git add -A && git commit` or `git stash`), then retry. Or use --best-of-n 1.";
  }
  return null;
}

export async function runCommand(args: ParsedArgs): Promise<void> {
  const progress = new ProgressDisplay();

  // 1. Build task string from positionals
  const task = args.positionals.join(" ").trim();
  if (!task) {
    process.stderr.write(
      "[smallcode] Error: no task specified. Usage: smallcode run <task description>\n",
    );
    process.exit(1);
  }

  process.stderr.write(`[smallcode] Task: ${task}\n`);

  // 2. Load config
  const configPath = flagString(args.flags, "config");
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(configPath);
  } catch (err) {
    progress.showError(`could not load config: ${String(err)}`);
    process.exit(1);
  }

  const { config, extraModels } = loaded;

  // 3. Build model registry and resolve profile
  const registry = new ModelRegistry(extraModels);
  const modelId = flagString(args.flags, "model") ?? config.activeModel;
  let profile: ReturnType<typeof registry.get>;
  try {
    profile = registry.get(modelId);
  } catch (err) {
    progress.showError(String(err));
    process.exit(1);
  }

  // 4. Create provider + reasoning handler
  const provider = createProvider(config.provider, registry);
  const reasoningHandler = profile.reasoningTags
    ? new ReasoningHandler(profile.reasoningTags)
    : new ReasoningHandler({ open: "<think>", close: "</think>" });

  // 5. Build AgentConfig
  const repoRoot = resolve(flagString(args.flags, "repo") ?? process.cwd());
  const maxTurns = flagNumber(args.flags, "max-turns") ?? config.maxTurns;
  const bestOfN = flagNumber(args.flags, "best-of-n") ?? config.bestOfN;
  // R1 escalation ladder: --escalation overrides config.escalation; comma-separated
  // model ids, cheapest first. Only meaningful with bestOfN > 1.
  const escalationFlag = flagString(args.flags, "escalation");
  const escalationSpec = escalationFlag
    ? escalationFlag
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : (config.escalation ?? []);

  const agentConfig: AgentConfig = {
    repoRoot,
    modelId,
    maxTurns,
    bestOfN,
    allowedCommands: config.sandbox?.allowedCommands,
    requireApproval: config.sandbox?.requireApproval,
  };

  // 6. Create state
  const state = createState(agentConfig, task);
  const statePath = getStatePath(agentConfig);

  // 6b. Index the repository so the agent can SEE the codebase (symbol map +
  // query-relevant file chunks). Without this the model runs blind and can only
  // guess file names. The budget is derived from the model's OPERATIVE window
  // (num_ctx, not the nominal contextWindow) minus the generation reserve —
  // otherwise repo context overflows the real window and Ollama returns HTTP
  // 400 after a few turns. See models/context-budget.ts.
  process.stderr.write("[smallcode] Scanning repository...\n");
  const ctxBudget = contextBudgetFor(profile);
  let repoMap: Awaited<ReturnType<typeof walkRepo>>;
  try {
    repoMap = await walkRepo({ root: repoRoot }, Date.now());
    process.stderr.write(
      `[smallcode] Indexed ${repoMap.files.length} files, ${repoMap.totalSymbols} symbols\n`,
    );
  } catch (err) {
    progress.showError(`repository scan failed: ${String(err)}`);
    process.exit(1);
  }

  async function buildBundle(query: string): Promise<ContextBundle> {
    try {
      return await buildContext(repoMap, query, { repoRoot, tokenBudget: ctxBudget });
    } catch {
      return { chunks: [], totalTokens: 0, tokenBudget: ctxBudget, truncated: false, query };
    }
  }

  // 7. Plan task — planner sees the repo context for the task.
  process.stderr.write("[smallcode] Planning...\n");
  const planningContext = await buildBundle(task);

  const plannerOpts = {
    provider,
    modelId,
    profile,
    repoRoot,
  };

  let goals: ReturnType<typeof createState>["goals"];
  try {
    goals = await planTask(task, planningContext, plannerOpts);
  } catch (err) {
    progress.showError(`planning failed: ${String(err)}`);
    process.exit(1);
  }

  state.goals = goals;

  // 8. Show goals
  progress.showGoals(goals);

  // 9. Show first turn start
  const firstGoal = goals[0];
  if (firstGoal !== undefined) {
    progress.showTurnStart(1, maxTurns, firstGoal.description);
  }

  // 10. getContext callback — returns repo context relevant to the current goal.
  function getContext(goal: string): Promise<ContextBundle> {
    return buildBundle(goal);
  }

  const deps = {
    provider,
    profile,
    reasoningHandler,
    config: agentConfig,
  };

  // 11. Run loop — single-shot, or run-level Best-of-N (optionally with the R1
  // model-escalation ladder) when bestOfN > 1.
  let finalState: typeof state;
  if (bestOfN > 1) {
    // Guard: BoN rolls the working tree back between attempts, so it needs a git
    // repo with nothing uncommitted to clobber.
    const gitErr = checkBonGitPreconditions(repoRoot);
    if (gitErr) {
      progress.showError(gitErr);
      process.exit(1);
    }
    // Build the escalation ladder (if any); rungs share this run's provider.
    const escalationLadder =
      escalationSpec.length > 0
        ? buildEscalationLadder({ spec: escalationSpec.join(","), registry, provider })
        : undefined;
    const baseline = captureTestBaseline(repoRoot);
    process.stderr.write(
      `[smallcode] run-level Best-of-N=${bestOfN}${escalationLadder ? ` with escalation [${escalationSpec.join(" → ")}]` : ""} — clean git tree required; losing attempts are rolled back.\n`,
    );
    try {
      const bon = await runBestOfNLoop({
        n: bestOfN,
        models: escalationLadder,
        deps,
        setup: async (attempt) => {
          // Roll the tree back to its pre-run state before every attempt after the
          // first (attempt 0 starts from the already-clean tree).
          if (attempt > 0) {
            git(["reset", "--hard", "HEAD"], repoRoot);
            git(["clean", "-fd"], repoRoot);
          }
          const aState = createState(agentConfig, task);
          aState.goals = goals.map((g) => ({ ...g }));
          return { state: aState, statePath: getStatePath(agentConfig), getContext };
        },
        verify: async () => (await runTieredOracle(repoRoot, { baseline })).outcome === "solved",
      });
      finalState =
        bon.states[bon.winningAttempt ?? bon.states.length - 1] ?? state;
      if (bon.winningModelId) {
        process.stderr.write(
          `[smallcode] Best-of-N resolved on attempt ${(bon.winningAttempt ?? 0) + 1}/${bon.attemptsUsed} via ${bon.winningModelId}.\n`,
        );
      }
    } catch (err) {
      progress.showError(`agent loop failed: ${String(err)}`);
      process.exit(1);
    }
  } else {
    try {
      finalState = await runLoop(state, statePath, deps, getContext);
    } catch (err) {
      progress.showError(`agent loop failed: ${String(err)}`);
      process.exit(1);
    }
  }

  // 12. Show completion or error — honest verdict only.
  const classification = classifyCompletion(finalState, statePath);
  if (classification.ok) {
    progress.showComplete(finalState);
    return;
  }

  // Oracle-free honesty: a non-verified end (unverified finish OR max_turns) often
  // just means NO TEST covered the change — not that anything failed. Run one final
  // check; if there is no test oracle, report the deterministic static-confidence
  // (what WAS checked) instead of a bare "without solving". Applies to both the
  // warn (model finished) and error (max_turns) cases.
  let msg = classification.message;
  try {
    const verdict = await runTieredOracle(repoRoot, {});
    if (verdict.outcome === "clean" && verdict.confidence) {
      msg = `No test covers this change — ${renderConfidence(verdict.confidence)}. Review ${statePath}`;
    }
  } catch {
    // keep the plain message
  }
  if (classification.tone === "warn") progress.showWarn(msg);
  else progress.showError(msg);
  process.exit(1);
}
