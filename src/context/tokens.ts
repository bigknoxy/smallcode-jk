import type { ContextChunk } from "./types.ts";

// Approximation: ~4 chars per token for code (GPT-style BPE heuristic).
// Returns integer, minimum 1.
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

// Returns how many chars fit within a token budget.
export function charsForTokens(tokens: number): number {
  return tokens * 4;
}

// Estimate tokens for a ContextChunk's content.
export function chunkTokens(chunk: ContextChunk): number {
  return estimateTokens(chunk.content);
}
