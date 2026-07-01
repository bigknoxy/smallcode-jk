import { resolve } from "node:path";
import { git } from "@/util/git.ts";
import { runLoop } from "../../agent/loop.ts";
import { planTask } from "../../agent/planner.ts";
import { createState, getStatePath } from "../../agent/state.ts";
import type { AgentConfig } from "../../agent/types.ts";
import { loadConfig } from "../../config/loader.ts";
import { buildContext, walkRepo } from "../../context/index.ts";
import type { ContextBundle } from "../../context/types.ts";
import { contextBudgetFor } from "../../models/context-budget.ts";
import { ModelRegistry } from "../../models/registry.ts";
import { createProvider } from "../../provider/factory.ts";
import { ReasoningHandler } from "../../reasoning/handler.ts";
import type { ParsedArgs } from "../args.ts";
import { classifyCompletion } from "./run.ts";
import {
  changedSets,
  makeInteractiveApprover,
  readManifest,
  recordAgentChanges,
  revertAgentChanges,
  workingChanges,
} from "./review.ts";

// R9 dev-UX: an interactive multi-task session. Unlike `smallcode run` (one task,
// cold start, exit), `chat` keeps the repo index + model + a pinned-file set warm
// across many tasks, and exposes /diff and /undo inline so the user reviews and
// reverts without leaving the loop. Slash-commands manage the session; any other
// line is a coding task run through the same plan→loop pipeline `run` uses.

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

const HELP = `Commands:
  /help            show this help
  /files           list pinned files (biased into retrieval)
  /add <path>...   pin file(s) so the agent focuses on them
  /drop <path>...  unpin file(s)
  /model <id>      switch model for this session
  /diff            show what the agent changed (git working tree)
  /undo            revert the agent's changes (asks: type /undo! to confirm)
  /clear           unpin all files
  /exit            quit (or Ctrl-D)
Anything else is a coding task.`;

export async function chatCommand(args: ParsedArgs): Promise<void> {
  const repoRoot = resolve(flagString(args.flags, "repo") ?? process.cwd());
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(flagString(args.flags, "config"));
  } catch (err) {
    process.stderr.write(`[smallcode] could not load config: ${String(err)}\n`);
    process.exit(1);
  }
  const { config, extraModels } = loaded;
  const registry = new ModelRegistry(extraModels);
  let modelId = flagString(args.flags, "model") ?? config.activeModel;
  const provider = createProvider(config.provider, registry);

  const pinned = new Set<string>();
  const isGit = git(["rev-parse", "--git-dir"], repoRoot).ok;

  process.stdout.write(`smallcode chat — repo ${repoRoot}, model ${modelId}${isGit ? "" : " (not a git repo: /diff and /undo disabled)"}\nType /help for commands, /exit to quit.\n`);

  async function runTask(task: string): Promise<void> {
    let profile: ReturnType<typeof registry.get>;
    try {
      profile = registry.get(modelId);
    } catch (err) {
      process.stderr.write(`[smallcode] ${String(err)}\n`);
      return;
    }
    const reasoningHandler = new ReasoningHandler(profile.reasoningTags ?? { open: "<think>", close: "</think>" });
    const ctxBudget = contextBudgetFor(profile);
    // Re-index each task so edits from prior tasks are visible.
    const repoMap = await walkRepo({ root: repoRoot }, Date.now());
    const buildBundle = async (query: string): Promise<ContextBundle> => {
      try {
        return await buildContext(repoMap, query, { repoRoot, tokenBudget: ctxBudget });
      } catch {
        return { chunks: [], totalTokens: 0, tokenBudget: ctxBudget, truncated: false, query };
      }
    };
    // Pinned files bias retrieval: name them in the query so the scorer lifts them.
    const pinnedHint = pinned.size > 0 ? ` (focus on: ${[...pinned].join(", ")})` : "";
    const fullTask = task + pinnedHint;

    const agentConfig: AgentConfig = {
      repoRoot,
      modelId,
      maxTurns: config.maxTurns,
      bestOfN: 1,
      allowedCommands: config.sandbox?.allowedCommands,
      requireApproval: config.sandbox?.requireApproval,
    };
    const state = createState(agentConfig, fullTask);
    try {
      state.goals = await planTask(fullTask, await buildBundle(fullTask), { provider, modelId, profile, repoRoot });
    } catch (err) {
      process.stderr.write(`[smallcode] planning failed: ${String(err)}\n`);
      return;
    }
    let final: typeof state;
    const beforeDirty = isGit
      ? changedSets(repoRoot)
      : { tracked: new Set<string>(), untracked: new Set<string>() };
    try {
      const approveEdit = makeInteractiveApprover(config.sandbox?.requireApproval);
      final = await runLoop(
        state,
        getStatePath(agentConfig),
        { provider, profile, reasoningHandler, config: agentConfig, ...(approveEdit ? { approveEdit } : {}) },
        (g) => buildBundle(g),
      );
    } catch (err) {
      process.stderr.write(`[smallcode] agent loop failed: ${String(err)}\n`);
      return;
    }
    if (isGit) await recordAgentChanges(repoRoot, beforeDirty).catch(() => {});
    const c = classifyCompletion(final, getStatePath(agentConfig));
    process.stdout.write(`${c.ok ? "✓" : c.tone === "warn" ? "⚠" : "✗"} ${c.message}\n`);
    if (isGit) {
      const ch = workingChanges(repoRoot);
      if (ch.hasChanges) process.stdout.write(`changed:\n${ch.stat ? `${ch.stat}\n` : ""}${ch.untracked.length ? `  new: ${ch.untracked.join(", ")}\n` : ""}  (/diff to view, /undo to revert)\n`);
    }
  }

  process.stdout.write("\nsmallcode> ");
  for await (const raw of console) {
    const line = raw.trim();
    if (line.length === 0) {
      process.stdout.write("smallcode> ");
      continue;
    }
    const [cmd, ...rest] = line.split(/\s+/);
    if (cmd === "/exit" || cmd === "/quit") break;
    else if (cmd === "/help") process.stdout.write(`${HELP}\n`);
    else if (cmd === "/files") process.stdout.write(pinned.size ? `${[...pinned].join("\n")}\n` : "(no pinned files)\n");
    else if (cmd === "/add") rest.forEach((f) => pinned.add(f));
    else if (cmd === "/drop") rest.forEach((f) => pinned.delete(f));
    else if (cmd === "/clear") pinned.clear();
    else if (cmd === "/model") {
      const m = rest[0];
      if (m) { modelId = m; process.stdout.write(`model → ${modelId}\n`); }
      else process.stdout.write(`model is ${modelId}\n`);
    } else if (cmd === "/diff") {
      if (!isGit) process.stdout.write("not a git repo — /diff unavailable\n");
      else {
        const ch = workingChanges(repoRoot);
        process.stdout.write(ch.hasChanges ? `${git(["diff"], repoRoot).out}${ch.untracked.length ? `\nnew: ${ch.untracked.join(", ")}\n` : ""}` : "no changes\n");
      }
    } else if (cmd === "/undo" || cmd === "/undo!") {
      if (!isGit) process.stdout.write("not a git repo — /undo unavailable\n");
      else {
        const m = readManifest(repoRoot);
        if (!m) process.stdout.write("nothing recorded to undo (only reverts what the agent wrote)\n");
        else if (cmd !== "/undo!")
          process.stdout.write(
            `This reverts ONLY the agent's changes (your edits untouched):\n` +
              (m.tracked.length ? `  restore: ${m.tracked.join(", ")}\n` : "") +
              (m.untracked.length ? `  delete: ${m.untracked.join(", ")}\n` : "") +
              "Type /undo! to confirm.\n",
          );
        else {
          const r = revertAgentChanges(repoRoot);
          process.stdout.write(`✓ reverted ${r?.tracked.length ?? 0} edit(s) + removed ${r?.untracked.length ?? 0} file(s)\n`);
        }
      }
    } else if (cmd?.startsWith("/")) process.stdout.write(`unknown command ${cmd} — /help\n`);
    else await runTask(line);
    process.stdout.write("smallcode> ");
  }
  process.stdout.write("\nbye\n");
}
