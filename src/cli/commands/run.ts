import { resolve } from "node:path";
import { git, isGitRepo } from "@/util/git.ts";
import { runBestOfNLoop } from "../../agent/bestofn-loop.ts";
import { runEscalateOnFailure } from "../../agent/escalate-on-failure.ts";
import { buildEscalationLadder } from "../../agent/escalation.ts";
import { runLoop } from "../../agent/loop.ts";
import { planTask } from "../../agent/planner.ts";
import { createState, getStatePath } from "../../agent/state.ts";
import type { AgentConfig, AgentState } from "../../agent/types.ts";
import { loadConfig } from "../../config/loader.ts";
import {
  buildContext,
  type EmbedFn,
  embedFileIndex,
  makeOllamaEmbedder,
  walkRepo,
} from "../../context/index.ts";
import type { ContextBundle } from "../../context/types.ts";
import { contextBudgetFor } from "../../models/context-budget.ts";
import { ollamaNativeBase, pingOllama } from "../../models/ollama.ts";
import { ModelRegistry } from "../../models/registry.ts";
import { createProvider } from "../../provider/factory.ts";
import { ReasoningHandler } from "../../reasoning/handler.ts";
import { renderConfidence } from "../../verify/confidence.ts";
import { captureTestBaseline, runTieredOracle } from "../../verify/oracle.ts";
import type { ParsedArgs } from "../args.ts";
import { ProgressDisplay } from "../progress.ts";
import {
  changedSets,
  makeInteractiveApprover,
  numstatChanges,
  recordAgentChanges,
  revertAgentChanges,
  workingChanges,
} from "./review.ts";

// ---------------------------------------------------------------------------
// classifyCompletion — pure helper; no I/O; exported for unit tests.
// ---------------------------------------------------------------------------

/**
 * E2-T2: the human-facing message when Ollama can't be reached before a run.
 * Pure/exported so the exact copy is unit-tested. Leads with WHAT is wrong and
 * the ONE command that fixes it, then points at `doctor` for a full diagnosis.
 */
export function ollamaUnreachableMessage(baseUrl: string, error?: string): string {
  const url = ollamaNativeBase(baseUrl);
  return (
    `Ollama not reachable at ${url}${error ? ` (${error})` : ""}. ` +
    `Is the server running? Start it with 'ollama serve' (or open the Ollama app), then re-run. ` +
    `Run 'smallcode doctor' for a full setup check.`
  );
}

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

// ---------------------------------------------------------------------------
// E1-T5 — honest run outcome: WHY it failed / HOW it was solved. Pure, exported
// for unit tests. Silent mediocrity (a confidently-wrong diff with no signal)
// kills trust faster than an honest failure, so every run states plainly whether
// it solved the task, by what mechanism, and — when it didn't — why + the tree state.
// ---------------------------------------------------------------------------

export interface RunOutcomeSummary {
  solved: boolean;
  /** How a SOLVED run was solved; "none" when unsolved. */
  mechanism: "model" | "harness-rescue" | "escalated" | "none";
  /** Rescue label / escalated model id; "" otherwise. */
  mechanismDetail: string;
  /** The final-state guard fired (the run was left worse and reverted). */
  guardFired: boolean;
  /** E1-T3 verified restore; null when the guard did not fire. */
  restoreVerified: boolean | null;
  /** Files the guard restored to pristine (0 when it didn't fire). */
  filesRestored: number;
  /** Best-known failing test names on a non-solve. */
  failingTests: string[];
  /** Human "why not solved" (empty when solved). */
  reason: string;
}

/**
 * Derive the honest outcome from the finished state. Pure. `escalatedTo` is the
 * model id that solved it via the escalation ladder (known only to run.ts's
 * EscalateResult, not to `finalState`) — pass it so a solved-by-escalation run is
 * attributed correctly; omit otherwise.
 */
export function summarizeOutcome(
  finalState: Pick<AgentState, "status" | "verified" | "turns" | "finalStateReverted">,
  escalatedTo?: string,
): RunOutcomeSummary {
  const solved = finalState.verified === true;
  const rescueTurn = finalState.turns.find((t) => t.mutationRepair !== undefined);
  const guard = finalState.finalStateReverted;

  let mechanism: RunOutcomeSummary["mechanism"] = "none";
  let mechanismDetail = "";
  if (solved) {
    if (escalatedTo) {
      mechanism = "escalated";
      mechanismDetail = escalatedTo;
    } else if (rescueTurn?.mutationRepair) {
      mechanism = "harness-rescue";
      mechanismDetail = rescueTurn.mutationRepair.label;
    } else {
      mechanism = "model";
    }
  }

  // Best-known failing tests: the guard's regression list if it fired (the
  // authoritative end-state signal), else ONLY the LAST turn's revert/diagnostic
  // — never an older turn's, which may name a failure a later turn already fixed
  // (that would be a misleading "still failing" line).
  let failingTests: string[] = guard?.newFailures ? [...guard.newFailures] : [];
  if (failingTests.length === 0) {
    const last = finalState.turns[finalState.turns.length - 1];
    if (last?.reverted?.newFailures?.length) failingTests = [...last.reverted.newFailures];
    else if (last?.diagnostic?.assertionId) failingTests = [last.diagnostic.assertionId];
  }

  let reason = "";
  if (!solved) {
    if (guard) {
      reason =
        `the run left the repo worse (red ${guard.startRed}→${guard.endRed}), so it was restored to ` +
        `its original state — no edits kept`;
    } else if (finalState.status === "max_turns") {
      reason = "ran out of turns without a green test result";
    } else if (finalState.status === "done") {
      reason = "finished without a test verifying the change as passing";
    } else if (finalState.status === "failed") {
      reason = "the run failed internally";
    } else {
      reason = `ended with status "${finalState.status}"`;
    }
  }

  return {
    solved,
    mechanism,
    mechanismDetail,
    guardFired: guard !== undefined,
    restoreVerified: guard ? guard.restoreVerified : null,
    filesRestored: guard?.filesRestored ?? 0,
    failingTests,
    reason,
  };
}

/** One-line "how this was solved" attribution for a solved run. */
export function renderSolvedAttribution(s: RunOutcomeSummary): string {
  switch (s.mechanism) {
    case "escalated":
      return `Solved after escalating to ${s.mechanismDetail}.`;
    case "harness-rescue":
      return `Solved by a harness rescue (operator/statement repair: ${s.mechanismDetail}) — not the model.`;
    default:
      return "Solved by the model.";
  }
}

/** The honest "couldn't fix + why + tree state" block for an unsolved run. */
export function renderFailureBlock(s: RunOutcomeSummary): string[] {
  const lines = [`Could not fix — ${s.reason}.`];
  if (s.guardFired) {
    lines.push(
      `Repo left unchanged: the guard restored ${s.filesRestored} file(s) to their original state` +
        (s.restoreVerified === false ? " (restore UNVERIFIED — see warnings above)" : " (restore verified)") +
        ".",
    );
  } else {
    lines.push("No edits were kept (nothing verified green).");
  }
  if (s.failingTests.length > 0) {
    lines.push(`Still failing: ${s.failingTests.slice(0, 5).join(", ")}.`);
  }
  return lines;
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

function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

// ---------------------------------------------------------------------------
// formatRunJson — pure helper for `--json` output; exported for unit tests.
// ---------------------------------------------------------------------------

export interface RunJsonResult {
  ok: boolean;
  verified: boolean;
  status: string;
  model: string;
  turnsUsed: number;
  filesChanged: string[];
  added: number;
  removed: number;
  reason: string;
  // E1-T5 honest-outcome fields (structured mirror of the human verdict).
  mechanism: RunOutcomeSummary["mechanism"];
  mechanismDetail: string;
  guardFired: boolean;
  restoreVerified: boolean | null;
  filesRestored: number;
  failingTests: string[];
}

/**
 * Build the single-line `--json` payload for `smallcode run`. Pure — no I/O.
 * `ok`/`status` come from the classification/finalState (NOT re-derived), so this
 * stays byte-for-byte consistent with the human-facing verdict.
 */
export function formatRunJson(
  finalState: Pick<AgentState, "status" | "verified" | "turns" | "finalStateReverted">,
  classification: CompletionClassification,
  changes: { filesChanged: string[]; added: number; removed: number },
  modelId: string,
  escalatedTo?: string,
): RunJsonResult {
  const outcome = summarizeOutcome(finalState, escalatedTo);
  return {
    ok: classification.ok,
    verified: finalState.verified === true,
    status: finalState.status,
    model: modelId,
    turnsUsed: finalState.turns.length,
    filesChanged: changes.filesChanged,
    added: changes.added,
    removed: changes.removed,
    reason: classification.ok ? "" : classification.message,
    mechanism: outcome.mechanism,
    mechanismDetail: outcome.mechanismDetail,
    guardFired: outcome.guardFired,
    restoreVerified: outcome.restoreVerified,
    filesRestored: outcome.filesRestored,
    failingTests: outcome.failingTests,
  };
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
  // E2-T2: fail fast with a human message if Ollama is unreachable, instead of a
  // cryptic inference timeout on the first model call several seconds in.
  const health = await pingOllama(config.provider.baseUrl);
  if (!health.ok) {
    progress.showError(ollamaUnreachableMessage(config.provider.baseUrl, health.error));
    process.exit(1);
  }
  const provider = createProvider(config.provider, registry);
  const reasoningHandler = profile.reasoningTags
    ? new ReasoningHandler(profile.reasoningTags)
    : new ReasoningHandler({ open: "<think>", close: "</think>" });

  // 5. Build AgentConfig
  const repoRoot = resolve(flagString(args.flags, "repo") ?? process.cwd());
  const maxTurns = flagNumber(args.flags, "max-turns") ?? config.maxTurns;
  const bestOfN = flagNumber(args.flags, "best-of-n") ?? config.bestOfN;
  // R1 escalation ladder (cheapest-first model ids). Precedence:
  //   1. --escalation <m1,m2,..>  — explicit ladder, always wins.
  //   2. explicit --model <id>    — SUPPRESSES the config default ladder: asking
  //      for one model means run exactly that model, not "climb from it".
  //   3. config.escalation        — the out-of-box default ladder (e.g. 3b,7b).
  const escalationFlag = flagString(args.flags, "escalation");
  const modelFlagGiven = flagString(args.flags, "model") !== undefined;
  const escalationSpec = escalationFlag
    ? escalationFlag
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : modelFlagGiven
      ? []
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
  // `let` (not const): the escalate-on-failure ladder recomputes this per rung so
  // a bigger model gets its own (larger) context budget. buildBundle closes over
  // the variable, so reassigning it before an attempt takes effect immediately.
  let ctxBudget = contextBudgetFor(profile);
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

  // 6c. Semantic retrieval (opt-in, SMALLCODE_SEMANTIC_RETRIEVAL=1). Build a
  // LOCAL embedder from the same base URL and embed the file INDEX once here, so
  // every buildBundle call (planner + each turn) reuses the query-independent
  // vectors. A down/absent embedder degrades to lexical-only (index is null →
  // buildContext embeds inline, and computeSemanticScores swallows failures).
  let semanticEmbed: EmbedFn | undefined;
  let semanticDocVectors: number[][] | undefined;
  if (process.env["SMALLCODE_SEMANTIC_RETRIEVAL"] === "1") {
    semanticEmbed = makeOllamaEmbedder({
      baseUrl: config.provider.baseUrl,
      model: process.env["SMALLCODE_EMBED_MODEL"] ?? "nomic-embed-text",
      apiKey: config.provider.apiKey,
    });
    process.stderr.write("[smallcode] Embedding file index for semantic retrieval...\n");
    const idx = await embedFileIndex(repoMap.files, semanticEmbed);
    if (idx) {
      semanticDocVectors = idx;
    } else {
      process.stderr.write(
        "[smallcode] Semantic index embedding failed — falling back to lexical retrieval.\n",
      );
    }
  }

  async function buildBundle(query: string): Promise<ContextBundle> {
    try {
      return await buildContext(repoMap, query, {
        repoRoot,
        tokenBudget: ctxBudget,
        ...(semanticEmbed ? { semanticEmbed } : {}),
        ...(semanticDocVectors ? { semanticDocVectors } : {}),
      });
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

  // Diff-review-before-write: when sandbox.requireApproval is on, the loop asks
  // the user to approve each proposed edit before it is written. Headless (no
  // TTY) or --yes bypasses the prompt and applies (issue #91) rather than
  // silently auto-declining every edit.
  const approveEdit = makeInteractiveApprover(config.sandbox?.requireApproval, {
    interactive: process.stdin.isTTY === true,
    bypass: flagBool(args.flags, "yes"),
  });
  const deps = {
    provider,
    profile,
    reasoningHandler,
    config: agentConfig,
    ...(approveEdit ? { approveEdit } : {}),
  };

  // Snapshot the pre-run dirty set so we can record EXACTLY what the agent
  // changes (vs the user's own pre-existing edits) for a safe, scoped `undo`.
  const preRunDirty = isGitRepo(repoRoot)
    ? changedSets(repoRoot)
    : { tracked: new Set<string>(), untracked: new Set<string>() };

  // 11. Run loop — single-shot, single-shot escalate-on-failure, or run-level
  // Best-of-N (optionally with the R1 model-escalation ladder) when bestOfN > 1.
  //
  // Escalate-on-failure eligibility, captured ONCE (a bun-test subprocess): only
  // when bestOfN === 1 AND a ladder is configured AND the repo is a git repo (the
  // scoped revert between rungs needs git) AND the baseline is genuinely red (a
  // failing test must exist for the oracle to confirm a "solve" to escalate ON).
  const escalationBaseline =
    bestOfN <= 1 && escalationSpec.length > 0 && isGitRepo(repoRoot)
      ? captureTestBaseline(repoRoot)
      : undefined;
  const canEscalateOnFailure =
    escalationBaseline !== undefined &&
    escalationBaseline.hadAnyTests &&
    (escalationBaseline.failingIds.size > 0 || escalationBaseline.redCount > 0);

  let finalState: typeof state;
  let solvedByEscalation: string | undefined; // set when the escalation ladder solved it (E1-T5 attribution)
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
      finalState = bon.states[bon.winningAttempt ?? bon.states.length - 1] ?? state;
      if (bon.winningModelId) {
        process.stderr.write(
          `[smallcode] Best-of-N resolved on attempt ${(bon.winningAttempt ?? 0) + 1}/${bon.attemptsUsed} via ${bon.winningModelId}.\n`,
        );
      }
    } catch (err) {
      progress.showError(`agent loop failed: ${String(err)}`);
      process.exit(1);
    }
  } else if (canEscalateOnFailure) {
    // Single-shot escalate-on-failure (bestOfN === 1 + an escalation ladder):
    // run the cheapest model; if the oracle doesn't confirm the fix, revert ONLY
    // the agent's edits (scoped manifest undo — the user's own work is preserved,
    // so NO clean-tree requirement) and retry with the next bigger LOCAL model.
    const baseline = escalationBaseline as ReturnType<typeof captureTestBaseline>;
    process.stderr.write(
      `[smallcode] escalate-on-failure ladder [${escalationSpec.join(" → ")}] — retries a bigger local model only if the current one fails; agent edits are reverted between attempts.\n`,
    );
    try {
      const result = await runEscalateOnFailure({
        models: escalationSpec,
        log: (m) => process.stderr.write(`[smallcode] ${m}\n`),
        reset: async () => {
          // Revert exactly what the just-failed attempt wrote (vs the pre-run
          // dirty set), leaving the user's own uncommitted edits untouched.
          await recordAgentChanges(repoRoot, preRunDirty);
          revertAgentChanges(repoRoot);
        },
        isSolved: async () => (await runTieredOracle(repoRoot, { baseline })).outcome === "solved",
        runAttempt: async (rungId) => {
          const rungProfile = registry.get(rungId);
          ctxBudget = contextBudgetFor(rungProfile);
          const rungDeps = {
            provider,
            profile: rungProfile,
            reasoningHandler: rungProfile.reasoningTags
              ? new ReasoningHandler(rungProfile.reasoningTags)
              : new ReasoningHandler({ open: "<think>", close: "</think>" }),
            config: { ...agentConfig, modelId: rungId },
            ...(approveEdit ? { approveEdit } : {}),
          };
          const rungState = createState({ ...agentConfig, modelId: rungId }, task);
          rungState.goals = goals.map((g) => ({ ...g }));
          return runLoop(rungState, getStatePath(agentConfig), rungDeps, getContext);
        },
      });
      finalState = result.finalState;
      if (result.solvedModelId) {
        solvedByEscalation = result.solvedModelId;
        process.stderr.write(
          `[smallcode] solved by ${result.solvedModelId} on attempt ${result.attemptsUsed}/${escalationSpec.length}.\n`,
        );
      } else {
        process.stderr.write(
          `[smallcode] escalation exhausted — none of [${escalationSpec.join(", ")}] solved it.\n`,
        );
      }
    } catch (err) {
      progress.showError(`agent loop failed: ${String(err)}`);
      process.exit(1);
    }
  } else {
    if (escalationSpec.length > 0) {
      // An escalation ladder was configured but can't apply this run — say why
      // rather than silently ignoring it.
      const why = !isGitRepo(repoRoot)
        ? "not a git repo (needed to revert edits between attempts)"
        : "no failing tests in the baseline to verify a fix against";
      process.stderr.write(
        `[smallcode] escalation [${escalationSpec.join(", ")}] not applied — ${why}; running ${modelId} single-shot.\n`,
      );
    }
    try {
      finalState = await runLoop(state, statePath, deps, getContext);
    } catch (err) {
      progress.showError(`agent loop failed: ${String(err)}`);
      process.exit(1);
    }
  }

  // 12. Show completion or error — honest verdict only.
  const classification = classifyCompletion(finalState, statePath);

  // Record what the agent changed (vs preRunDirty) so `undo` reverts only that.
  if (isGitRepo(repoRoot)) {
    try {
      await recordAgentChanges(repoRoot, preRunDirty);
    } catch {
      // non-fatal: undo just won't have a manifest
    }
  }

  // R9 dev-UX: end every run with a review/undo summary so the agent is never a
  // black box — the user sees what changed and how to take it back.
  const changes = workingChanges(repoRoot);
  if (changes.hasChanges) {
    process.stderr.write(
      `[smallcode] Changed:\n${changes.stat ? `${changes.stat}\n` : ""}` +
        (changes.untracked.length ? `  new: ${changes.untracked.join(", ")}\n` : "") +
        "[smallcode] Review: smallcode diff --repo <repo>  ·  Undo: smallcode undo --repo <repo>\n",
    );
  }

  // --json: suppress the human-facing verdict and print exactly one JSON line to
  // stdout instead. ProgressDisplay + the informational writes above already went
  // to stderr, so stdout stays clean either way — this only replaces the final
  // showComplete/showWarn/showError call. Exit code is UNCHANGED either way.
  if (flagBool(args.flags, "json")) {
    const jsonChanges = isGitRepo(repoRoot)
      ? numstatChanges(repoRoot)
      : { filesChanged: [], added: 0, removed: 0 };
    const payload = formatRunJson(finalState, classification, jsonChanges, modelId, solvedByEscalation);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (classification.ok) return;
    process.exit(1);
  }

  const outcome = summarizeOutcome(finalState, solvedByEscalation);

  if (classification.ok) {
    progress.showComplete(finalState);
    // E1-T5: one-line "how this was solved" attribution so a solve is never a
    // black box (model vs harness-rescue vs escalation).
    process.stderr.write(`[smallcode] ${renderSolvedAttribution(outcome)}\n`);
    return;
  }

  // E1-T5: honest "couldn't fix + why + tree state" block. Print BEFORE the
  // (possibly oracle-free) tone message so the failure is legible and the tree
  // state is explicit — never a silent, confidently-wrong diff.
  for (const line of renderFailureBlock(outcome)) process.stderr.write(`[smallcode] ${line}\n`);

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
