import { readFile, writeFile } from "node:fs/promises";
import path, { sep } from "node:path";
import type { ContextBundle } from "@/context/types.ts";
import { applyBatch, parse } from "@/edit/index.ts";
import { promptHardCap } from "@/models/context-budget.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { Provider } from "@/provider/types.ts";
import type { ReasoningHandler } from "@/reasoning/index.ts";
import { failureSignature } from "@/verify/failure-extract.ts";
import { captureTestBaseline, runTieredOracle } from "@/verify/oracle.ts";
import { planTask } from "./planner.ts";
import { buildSystemPrompt, fitTurnPromptToWindow } from "./prompt.ts";
import { addTurn, advanceGoal, currentGoal, isTerminal, saveState } from "./state.ts";
import { rotateStrategy } from "./strategy.ts";
import { executeTool, type ToolContext } from "./tools.ts";
import type { AgentConfig, AgentState, ToolCall, ToolName, TurnRecord } from "./types.ts";

const STALL_LIMIT = 2;
const MAX_REDRAFTS = 2;

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
  // Ceiling for system + user prompt; repo context is trimmed to fit so the
  // request never overflows the model window (HTTP 400) or starves generation.
  const hardCap = promptHardCap(profile);

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
      preSolveReflection: config.preSolveReflection,
      plannerPrompt: config.promptSet?.planner,
      reflectionPrompt: config.promptSet?.reflection,
    });
    await saveState(state, statePath);
  }

  // Capture a pre-loop baseline of any already-failing tests so that
  // pre-existing unrelated failures don't prevent early-stop after the task
  // is solved.  On fresh single-file benchmark repos (no pre-existing failures)
  // the baseline set is empty and behaviour is identical to before this fix.
  const testBaseline = captureTestBaseline(state.repoRoot);

  // Stall/redraft carry-forward: tracks whether the NEXT turn should be a redraft.
  let redraftNext = false;
  let redraftStrategyHint: string | undefined;
  // Think-only recovery carry-forward: set when a turn truncates mid-reasoning
  // (emits reasoning but no answer). The NEXT turn is drafted under the
  // ANSWER-NOW prompt so the model stops thinking and acts. Without this, the
  // identical prompt was retried and the model truncated the same way again.
  let answerNowNext = false;

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
    // Set when this turn truncates mid-reasoning; drives the answer-now recovery.
    let thinkOnly = false;

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

    // Build turn prompt. Answer-now recovery (think-only truncation last turn)
    // takes precedence over a stall redraft — getting ANY answer out beats trying
    // a different approach when the model never finished speaking.
    const turnAnswerNow = answerNowNext;
    const turnPromptOpts = turnAnswerNow
      ? { answerNow: true }
      : redraftNext
        ? { redraft: true, strategyHint: redraftStrategyHint }
        : undefined;
    const fitted = fitTurnPromptToWindow(state, context, systemPrompt, hardCap, turnPromptOpts);
    const turnPrompt = fitted.turnPrompt;
    if (fitted.droppedChunks > 0) {
      process.stderr.write(
        `[smallcode] trimmed ${fitted.droppedChunks} context chunk(s) to fit window (~${fitted.estimatedTokens}/${hardCap} tokens)\n`,
      );
    }
    // Consume the carry-forward flags (they apply to this turn only).
    redraftNext = false;
    redraftStrategyHint = undefined;
    answerNowNext = false;

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
      // Treat as an error turn rather than silently scoring a non-answer, and flag
      // the next turn for answer-now recovery so we don't re-run the same prompt.
      if (parsed.hasReasoning && answer === "" && response.truncated !== false) {
        thinkOnly = true;
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
        ...(turnAnswerNow && { answerNow: true }),
      };

      addTurn(state, failedTurn);

      // Think-only truncation → draft the NEXT turn under the answer-now prompt
      // (skip thinking, act immediately) instead of re-running the identical
      // prompt that just truncated. No-op if this was already the last turn.
      if (thinkOnly && state.turns.length < state.maxTurns) {
        answerNowNext = true;
      }
      await saveState(state, statePath);

      // Check maxTurns after adding the failed turn
      if (state.turns.length >= state.maxTurns) {
        state.status = "max_turns";
        await saveState(state, statePath); // FIX #5: persist max_turns so state.json never shows "running"
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
      verdict = await runTieredOracle(state.repoRoot, { baseline: testBaseline });
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

    // Stall detection: compute failure signature and check if we're stuck.
    //
    // Fix 3b: Gate stall on verdict.outcome === "failing" ALONE — do NOT require
    // verdict.diagnostic to be present. When diagnostic is available use it for
    // a stable signature; otherwise fall back to a stable hash of the feedback
    // text. This ensures typecheck-tier failures (where extractFirstFailure
    // previously returned null) also participate in stall detection.
    let turnFailureSig: string | undefined;
    let turnRedrafted = false;

    if (verdict?.outcome === "failing") {
      // Compute a stable signature: prefer the structured diagnostic; fall back
      // to the first 200 chars of feedback (already stable — no timing, no paths
      // in tsc/feedback text after normalization).
      if (verdict.diagnostic) {
        turnFailureSig = failureSignature(verdict.diagnostic);
      } else {
        // Stable fallback from feedback text — normalize timing/paths/whitespace.
        const fbStable = (verdict.feedback ?? "")
          .replace(/\[\d+(?:\.\d+)?ms\]/g, "")
          .replace(/\/[^\s'"]+\/([^/\s'"]+)/g, "<path>/$1")
          .replace(/:\d+:\d+/g, ":<loc>")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        turnFailureSig = `feedback:${fbStable}`;
      }

      if (turnFailureSig === state.lastFailureSignature) {
        // Same failure again — increment stall counter.
        state.stallCount = (state.stallCount ?? 0) + 1;
      } else {
        // Different failure — reset stall counter.
        state.stallCount = 0;
      }
      state.lastFailureSignature = turnFailureSig;

      // Fire redraft when stall limit reached and we haven't exhausted redrafts.
      if (state.stallCount >= STALL_LIMIT && (state.redraftCount ?? 0) < MAX_REDRAFTS) {
        redraftNext = true;
        redraftStrategyHint = rotateStrategy(state.redraftCount ?? 0);
        state.stallCount = 0;
        state.lastFailureSignature = undefined;
        state.redraftCount = (state.redraftCount ?? 0) + 1;
        turnRedrafted = true;
      }
    } else {
      // Non-failing outcome (solved / clean / none) resets the stall counter.
      state.stallCount = 0;
      state.lastFailureSignature = undefined;
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
      ...(turnFailureSig !== undefined && { failureSignature: turnFailureSig }),
      ...(turnRedrafted && { redrafted: true }),
      ...(turnAnswerNow && { answerNow: true }),
      ...(verdict?.diagnostic && { diagnostic: verdict.diagnostic }),
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
      state.verified = true;
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
      await saveState(state, statePath); // FIX #5: persist max_turns so state.json never shows "running"
      break;
    }
  }

  return state;
}
