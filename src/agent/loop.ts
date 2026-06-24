import { readFile, writeFile } from "node:fs/promises";
import path, { sep } from "node:path";
import type { ContextBundle } from "@/context/types.ts";
import { applyBatch, parse } from "@/edit/index.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { Provider } from "@/provider/types.ts";
import type { ReasoningHandler } from "@/reasoning/index.ts";
import { planTask } from "./planner.ts";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt.ts";
import { addTurn, advanceGoal, currentGoal, isTerminal, saveState } from "./state.ts";
import { type ToolContext, executeTool } from "./tools.ts";
import { runTieredOracle } from "@/verify/oracle.ts";
import type { AgentConfig, AgentState, ToolCall, ToolName, TurnRecord } from "./types.ts";

export interface LoopDependencies {
  provider: Provider;
  profile: ModelProfile;
  reasoningHandler: ReasoningHandler;
  config: AgentConfig;
  /**
   * Optional per-run sampling override. Best-of-N uses this to vary temperature
   * across attempts so independent retries explore different solutions instead
   * of re-drawing the same one. Falls back to the model profile defaults.
   */
  samplingOverride?: { temperature?: number; top_p?: number };
}

interface ParsedToolCall {
  name: ToolName;
  args: Record<string, unknown>;
  success: boolean;
  error?: string;
}

const KNOWN_TOOL_NAMES = new Set<ToolName>([
  "read_file",
  "write_file",
  "run_command",
  "run_tests",
  "finish",
  "think",
]);

function isToolName(name: string): name is ToolName {
  return KNOWN_TOOL_NAMES.has(name as ToolName);
}

function parseToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  // Match TOOL: <name> <json> on a single line
  const toolLineRe = /^TOOL:\s+(\S+)\s+(\{.*\}|\[\])\s*$/gm;
  // Also match TOOL: <name> {} with empty braces potentially
  const toolNoArgsRe = /^TOOL:\s+(\S+)\s*$/gm;

  const seenOffsets = new Set<number>();

  for (const match of text.matchAll(toolLineRe)) {
    const offset = match.index ?? 0;
    seenOffsets.add(offset);
    const rawName = match[1] ?? "";
    const rawArgs = match[2] ?? "{}";

    if (!isToolName(rawName)) {
      results.push({
        name: "think",
        args: {},
        success: false,
        error: `Unknown tool name: ${rawName}`,
      });
      continue;
    }

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        args = {};
      }
    } catch (err) {
      results.push({
        name: rawName,
        args: {},
        success: false,
        error: `Malformed JSON args: ${String(err)}`,
      });
      continue;
    }

    results.push({ name: rawName, args, success: true });
  }

  // Also capture bare tool calls without JSON args (e.g., TOOL: run_tests)
  for (const match of text.matchAll(toolNoArgsRe)) {
    const offset = match.index ?? 0;
    if (seenOffsets.has(offset)) continue;
    const rawName = match[1] ?? "";
    if (!isToolName(rawName)) continue;
    results.push({ name: rawName, args: {}, success: true });
  }

  return results;
}

function safeResolve(repoRoot: string, p: string): string | null {
  const base = path.resolve(repoRoot) + sep;
  const abs = path.resolve(repoRoot, p);
  if (!(abs + sep).startsWith(base)) return null;
  return abs;
}

function buildReadFile(repoRoot: string): (p: string) => Promise<string | null> {
  return async (p: string): Promise<string | null> => {
    const abs = safeResolve(repoRoot, p);
    if (abs === null) return null;
    try {
      return await readFile(abs, "utf-8");
    } catch {
      return null;
    }
  };
}

function buildWriteFile(repoRoot: string): (p: string, content: string) => Promise<void> {
  return async (p: string, content: string): Promise<void> => {
    const abs = safeResolve(repoRoot, p);
    if (abs === null) throw new Error(`Path traversal rejected: ${p}`);
    await writeFile(abs, content, "utf-8");
  };
}

export async function runLoop(
  state: AgentState,
  statePath: string,
  deps: LoopDependencies,
  getContext: (goal: string) => Promise<ContextBundle>,
): Promise<AgentState> {
  const { provider, profile, reasoningHandler, config } = deps;
  const sampleTemp = deps.samplingOverride?.temperature ?? profile.samplingDefaults.temperature;
  const sampleTopP = deps.samplingOverride?.top_p ?? profile.samplingDefaults.top_p;
  const systemPrompt = buildSystemPrompt(profile, config);

  const readFileFn = buildReadFile(state.repoRoot);
  const writeFileFn = buildWriteFile(state.repoRoot);

  // Tool execution context. Model-emitted tool calls (run_tests, run_command,
  // read_file) were previously parsed but never executed — the agent flew blind,
  // calling `finish` without ever verifying. We now execute them and, critically,
  // run the test suite at the end of each turn as a deterministic pass-oracle.
  const toolCtx: ToolContext = {
    repoRoot: state.repoRoot,
    allowedCommands: config.allowedCommands ?? ["bun", "tsc", "biome", "git"],
    requireApproval: config.requireApproval ?? false,
  };

  // Planning phase: decompose the task into goals if none exist yet.
  if (state.goals.length === 0) {
    let context: ContextBundle;
    try {
      context = await getContext(state.task);
    } catch {
      context = { chunks: [], totalTokens: 0, tokenBudget: 0, truncated: false, query: state.task };
    }
    state.goals = await planTask(state.task, context, {
      provider,
      modelId: state.modelId,
      profile,
      repoRoot: state.repoRoot,
    });
    await saveState(state, statePath);
  }

  while (!isTerminal(state) && state.turns.length < state.maxTurns) {
    const goal = currentGoal(state);
    if (goal === null) {
      state.status = "done";
      break;
    }

    // Mark goal in_progress
    goal.status = "in_progress";

    let rawResponse = "";
    let reasoning: string | undefined;
    let answer = "";
    let promptTokens = 0;
    let completionTokens = 0;

    let context: ContextBundle;
    try {
      context = await getContext(goal.description);
    } catch {
      context = {
        chunks: [],
        totalTokens: 0,
        tokenBudget: 0,
        truncated: false,
        query: goal.description,
      };
    }

    const turnPrompt = buildTurnPrompt(state, context);

    try {
      const response = await provider.complete({
        model: state.modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: turnPrompt },
        ],
        temperature: sampleTemp,
        top_p: sampleTopP,
        max_tokens: profile.samplingDefaults.max_tokens,
        ollamaOptions: profile.ollamaOptions,
      });

      rawResponse = response.rawContent;
      promptTokens = response.usage?.promptTokens ?? 0;
      completionTokens = response.usage?.completionTokens ?? 0;

      const parsed = reasoningHandler.parse(rawResponse);
      reasoning = parsed.reasoning ?? undefined;
      answer = parsed.answer;

      // Think-only truncation: reasoning present but answer empty → completion was cut short.
      // Treat as an error turn rather than silently scoring a non-answer.
      if (parsed.hasReasoning && answer === "" && response.truncated !== false) {
        throw new Error(
          "think-only completion: model emitted reasoning but no answer (likely truncated)",
        );
      }
    } catch (err) {
      // Record a failed turn but continue
      rawResponse = "";
      answer = "";
      reasoning = undefined;
      const errMsg = err instanceof Error ? err.message : String(err);

      const failedTurn: TurnRecord = {
        turn: state.turns.length + 1,
        goalId: goal.id,
        prompt: turnPrompt,
        rawResponse,
        reasoning,
        answer,
        toolCalls: [],
        toolResults: [{ name: "think", success: false, output: "", error: errMsg }],
        editBlocks: [],
        applyResults: [],
        promptTokens,
        completionTokens,
        timestamp: Date.now(),
      };

      addTurn(state, failedTurn);
      await saveState(state, statePath);

      // Check maxTurns after adding the failed turn
      if (state.turns.length >= state.maxTurns) {
        state.status = "max_turns";
      }
      continue;
    }

    // Parse edit blocks from answer
    const parseResult = parse(answer);
    const editBlocks = parseResult.blocks;

    // Apply edits
    let applyResults: import("@/edit/types.ts").ApplyResult[] = [];
    if (editBlocks.length > 0) {
      try {
        const batchResult = await applyBatch(editBlocks, readFileFn, writeFileFn);
        applyResults = batchResult.results;
      } catch {
        applyResults = [];
      }
    }

    // Parse tool calls from answer
    const parsedToolCalls = parseToolCalls(answer);
    const toolCalls: ToolCall[] = parsedToolCalls
      .filter((tc) => tc.success)
      .map((tc) => ({ name: tc.name, args: tc.args }));

    // Build tool results: start with failed parses.
    const toolResults: TurnRecord["toolResults"] = parsedToolCalls
      .filter((tc) => !tc.success)
      .map((tc) => ({
        name: tc.name,
        success: false,
        output: "",
        error: tc.error,
      }));

    // Execute model-emitted side-effecting tool calls (read_file, run_command,
    // run_tests) so their real output feeds back into the next turn. think/finish
    // are control-flow only and handled separately below.
    for (const call of toolCalls) {
      if (call.name === "think" || call.name === "finish") continue;
      try {
        toolResults.push(await executeTool(call, toolCtx));
      } catch (err) {
        toolResults.push({
          name: call.name,
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Tiered verification oracle (authoritative end-of-turn check). Tier 1 is the
    // test suite — green == solved (the trial/grader suite is the same one). When
    // NO test covers the change (real repos editing untested code), it falls back
    // to a typecheck so the agent still gets ground-truth feedback instead of
    // flying blind. Outcome drives early-stop below.
    let verdict: Awaited<ReturnType<typeof runTieredOracle>> | undefined;
    try {
      verdict = await runTieredOracle(state.repoRoot);
      toolResults.push({
        name: "run_tests",
        success: verdict.outcome === "solved",
        output:
          verdict.outcome === "solved"
            ? "verified: tests pass"
            : verdict.outcome === "clean"
              ? "no failing checks (no test covers this change yet)"
              : verdict.feedback,
        error: verdict.outcome === "failing" ? verdict.feedback : undefined,
      });
    } catch {
      // Verification failure is non-fatal — continue the loop.
    }

    const turn: TurnRecord = {
      turn: state.turns.length + 1,
      goalId: goal.id,
      prompt: turnPrompt,
      rawResponse,
      reasoning,
      answer,
      toolCalls,
      toolResults,
      editBlocks,
      applyResults,
      promptTokens,
      completionTokens,
      timestamp: Date.now(),
    };

    addTurn(state, turn);
    await saveState(state, statePath);

    const hasFinish = parsedToolCalls.some((tc) => tc.name === "finish" && tc.success);

    // Early-stop: "solved" (tests green) is proven complete — lock it in and stop
    // before a later turn can regress it. "clean"/"failing" do not early-stop; for
    // untested changes the oracle's value is the feedback (type errors surfaced,
    // no-tests not treated as a hard fail), while completion still flows through
    // the model's finish → goal-advance → goal-exhaustion path below.
    if (verdict?.outcome === "solved") {
      for (const g of state.goals) g.status = "done";
      state.status = "done";
      await saveState(state, statePath);
      break;
    }
    if (hasFinish) {
      advanceGoal(state);
      await saveState(state, statePath);
    }

    // Check maxTurns
    if (state.turns.length >= state.maxTurns) {
      state.status = "max_turns";
      await saveState(state, statePath);
      break;
    }
  }

  return state;
}
