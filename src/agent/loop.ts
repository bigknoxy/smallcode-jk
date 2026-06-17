import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextBundle } from "@/context/types.ts";
import { applyBatch, parse } from "@/edit/index.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { Provider } from "@/provider/types.ts";
import type { ReasoningHandler } from "@/reasoning/index.ts";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt.ts";
import { addTurn, advanceGoal, currentGoal, isTerminal, saveState } from "./state.ts";
import type { AgentConfig, AgentState, ToolCall, ToolName, TurnRecord } from "./types.ts";

export interface LoopDependencies {
  provider: Provider;
  profile: ModelProfile;
  reasoningHandler: ReasoningHandler;
  config: AgentConfig;
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

function buildReadFile(repoRoot: string): (path: string) => Promise<string | null> {
  return async (path: string): Promise<string | null> => {
    try {
      const absPath = path.startsWith("/") ? path : join(repoRoot, path);
      return await readFile(absPath, "utf-8");
    } catch {
      return null;
    }
  };
}

function buildWriteFile(repoRoot: string): (path: string, content: string) => Promise<void> {
  return async (path: string, content: string): Promise<void> => {
    const absPath = path.startsWith("/") ? path : join(repoRoot, path);
    await writeFile(absPath, content, "utf-8");
  };
}

export async function runLoop(
  state: AgentState,
  statePath: string,
  deps: LoopDependencies,
  getContext: (goal: string) => Promise<ContextBundle>,
): Promise<AgentState> {
  const { provider, profile, reasoningHandler, config } = deps;
  const systemPrompt = buildSystemPrompt(profile, config);

  const readFileFn = buildReadFile(state.repoRoot);
  const writeFileFn = buildWriteFile(state.repoRoot);

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
        temperature: profile.samplingDefaults.temperature,
        top_p: profile.samplingDefaults.top_p,
        max_tokens: profile.samplingDefaults.max_tokens,
      });

      rawResponse = response.rawContent;
      promptTokens = response.usage?.promptTokens ?? 0;
      completionTokens = response.usage?.completionTokens ?? 0;

      const parsed = reasoningHandler.parse(rawResponse);
      reasoning = parsed.reasoning ?? undefined;
      answer = parsed.answer;
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

    // Build tool results for failed parses
    const toolResults: TurnRecord["toolResults"] = parsedToolCalls
      .filter((tc) => !tc.success)
      .map((tc) => ({
        name: tc.name,
        success: false,
        output: "",
        error: tc.error,
      }));

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

    // Check for finish tool call
    const hasFinish = parsedToolCalls.some((tc) => tc.name === "finish" && tc.success);
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
