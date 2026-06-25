/**
 * Tests for fitTurnPromptToWindow — the pre-flight guard that trims repo
 * context chunks until the assembled prompt fits the model window.
 *
 * Prevents the HTTP-400 overflow even when a single turn balloons (failed-edit
 * full-file re-injection into history on top of ## Relevant Context, or
 * approximate token estimation).
 */

import { describe, expect, it } from "bun:test";
import { fitTurnPromptToWindow } from "../src/agent/prompt.ts";
import type { AgentState } from "../src/agent/types.ts";
import { estimateTokens } from "../src/context/tokens.ts";
import type { ContextBundle, ContextChunk } from "../src/context/types.ts";

const SYSTEM = "You are a coding agent. Emit FILE: blocks.";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    sessionId: "s",
    task: "fix the bug",
    repoRoot: "/tmp/test",
    modelId: "test-model",
    goals: [{ id: "g1", description: "edit the file", status: "in_progress" }],
    currentGoalIndex: 0,
    turns: [],
    status: "running",
    scratchpad: "",
    startedAt: 0,
    updatedAt: 0,
    maxTurns: 10,
    ...overrides,
  };
}

function chunk(filePath: string, chars: number): ContextChunk {
  const content = "x".repeat(chars);
  return { filePath, startLine: 1, endLine: 1, content, estimatedTokens: estimateTokens(content) };
}

function makeContext(chunks: ContextChunk[]): ContextBundle {
  return {
    chunks,
    totalTokens: chunks.reduce((n, c) => n + c.estimatedTokens, 0),
    tokenBudget: 999_999,
    truncated: false,
    query: "edit the file",
  };
}

describe("fitTurnPromptToWindow", () => {
  it("drops nothing when the prompt already fits", () => {
    const ctx = makeContext([chunk("a.ts", 40), chunk("b.ts", 40)]);
    const r = fitTurnPromptToWindow(makeState(), ctx, SYSTEM, 100_000);
    expect(r.droppedChunks).toBe(0);
    expect(r.estimatedTokens).toBeLessThanOrEqual(100_000);
    expect(r.turnPrompt).toContain("a.ts");
    expect(r.turnPrompt).toContain("b.ts");
  });

  it("trims chunks until the prompt fits the hard cap", () => {
    const ctx = makeContext([chunk("a.ts", 4000), chunk("b.ts", 4000), chunk("c.ts", 4000)]);
    const hardCap = 600; // forces dropping most chunks
    const r = fitTurnPromptToWindow(makeState(), ctx, SYSTEM, hardCap);
    expect(r.estimatedTokens).toBeLessThanOrEqual(hardCap);
    expect(r.droppedChunks).toBeGreaterThan(0);
  });

  it("drops the LARGEST chunk first", () => {
    const small = chunk("small.ts", 40);
    const big = chunk("big.ts", 8000);
    const ctx = makeContext([small, big]);
    // Cap high enough for system+history+small, but not for big.
    const withSmallOnly = estimateTokens(SYSTEM) + 2000;
    const r = fitTurnPromptToWindow(makeState(), ctx, SYSTEM, withSmallOnly);
    expect(r.droppedChunks).toBe(1);
    expect(r.turnPrompt).toContain("small.ts");
    expect(r.turnPrompt).not.toContain("big.ts");
  });

  it("drops all chunks when even the scaffolding is over the cap (no infinite loop)", () => {
    const ctx = makeContext([chunk("a.ts", 4000), chunk("b.ts", 4000)]);
    const r = fitTurnPromptToWindow(makeState(), ctx, SYSTEM, 1);
    expect(r.droppedChunks).toBe(2);
    expect(r.turnPrompt).not.toContain("a.ts");
    expect(r.turnPrompt).not.toContain("b.ts");
  });

  it("is deterministic — same input yields same result", () => {
    const mk = () => makeContext([chunk("a.ts", 4000), chunk("b.ts", 2000), chunk("c.ts", 6000)]);
    const r1 = fitTurnPromptToWindow(makeState(), mk(), SYSTEM, 1500);
    const r2 = fitTurnPromptToWindow(makeState(), mk(), SYSTEM, 1500);
    expect(r1.droppedChunks).toBe(r2.droppedChunks);
    expect(r1.turnPrompt).toBe(r2.turnPrompt);
  });

  it("does not mutate the caller's context chunks array", () => {
    const chunks = [chunk("a.ts", 4000), chunk("b.ts", 4000)];
    const ctx = makeContext(chunks);
    fitTurnPromptToWindow(makeState(), ctx, SYSTEM, 1);
    expect(ctx.chunks).toHaveLength(2); // original untouched
  });
});
