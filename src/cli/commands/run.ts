import { resolve } from "node:path";
import { runLoop } from "../../agent/loop.ts";
import { planTask } from "../../agent/planner.ts";
import { createState, getStatePath } from "../../agent/state.ts";
import type { AgentConfig } from "../../agent/types.ts";
import { loadConfig } from "../../config/loader.ts";
import type { ContextBundle } from "../../context/types.ts";
import { ModelRegistry } from "../../models/registry.ts";
import { createProvider } from "../../provider/factory.ts";
import { ReasoningHandler } from "../../reasoning/handler.ts";
import type { ParsedArgs } from "../args.ts";
import { ProgressDisplay } from "../progress.ts";

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

  // 7. Plan task
  process.stderr.write("[smallcode] Planning...\n");

  // Build a minimal empty context for planning
  const emptyContext: ContextBundle = {
    chunks: [],
    totalTokens: 0,
    tokenBudget: profile.contextWindow,
    truncated: false,
    query: task,
  };

  const plannerOpts = {
    provider,
    modelId,
    profile,
    repoRoot,
  };

  let goals: ReturnType<typeof createState>["goals"];
  try {
    goals = await planTask(task, emptyContext, plannerOpts);
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

  // 10. getContext callback — returns empty context bundle (symbol-only for large repos)
  function getContext(_goal: string): Promise<ContextBundle> {
    return Promise.resolve({
      chunks: [],
      totalTokens: 0,
      tokenBudget: profile.contextWindow,
      truncated: false,
      query: _goal,
    });
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

  // 12. Show completion or error
  if (finalState.status === "failed") {
    progress.showError(`agent failed — check state at ${statePath}`);
    process.exit(1);
  } else {
    progress.showComplete(finalState);
  }
}
