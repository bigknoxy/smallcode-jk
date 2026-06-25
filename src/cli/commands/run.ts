import { resolve } from "node:path";
import { runLoop } from "../../agent/loop.ts";
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

  // 11. Run loop
  let finalState: typeof state;
  try {
    finalState = await runLoop(state, statePath, deps, getContext);
  } catch (err) {
    progress.showError(`agent loop failed: ${String(err)}`);
    process.exit(1);
  }

  // 12. Show completion or error — honest verdict only
  const classification = classifyCompletion(finalState, statePath);
  if (classification.ok) {
    progress.showComplete(finalState);
  } else if (classification.tone === "warn") {
    progress.showWarn(classification.message);
    process.exit(1);
  } else {
    progress.showError(classification.message);
    process.exit(1);
  }
}
