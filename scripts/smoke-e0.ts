#!/usr/bin/env bun
/**
 * E0 smoke test — verifies the live VibeThinker-3B Ollama endpoint:
 *   1. Connection works
 *   2. <think> splitting works on real output
 *   3. No think-only truncation at the chosen num_ctx
 *   4. num_ctx is large enough (check token usage vs limit)
 *
 * Run: bun scripts/smoke-e0.ts
 *
 * Expects Ollama running at http://localhost:11434 with vibethinker-3b loaded.
 */

import { loadConfig } from "../src/config/loader.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// A trivial coding task that should always produce reasoning + a short answer
const SMOKE_PROMPT = `Write a TypeScript function called \`add\` that takes two numbers and returns their sum. Return only the function, no explanation.`;

async function main(): Promise<void> {
  console.log("[smoke-e0] Loading config...");
  const { config, extraModels } = loadConfig();

  for (const m of extraModels) {
    defaultRegistry.register(m);
  }

  const profile = defaultRegistry.get(config.activeModel);
  const provider = createProvider(config.provider, defaultRegistry);
  const handler = new ReasoningHandler(profile.reasoningTags ?? { open: THINK_OPEN, close: THINK_CLOSE });

  console.log(`[smoke-e0] Model: ${profile.id}`);
  console.log(`[smoke-e0] Ollama options: ${JSON.stringify(profile.ollamaOptions ?? {})}`);
  console.log(`[smoke-e0] max_tokens: ${profile.samplingDefaults.max_tokens}`);
  console.log(`[smoke-e0] Sending smoke request...`);

  const t0 = Date.now();
  const response = await provider.complete({
    model: profile.id,
    messages: [
      {
        role: "user",
        content: SMOKE_PROMPT,
      },
    ],
    temperature: profile.samplingDefaults.temperature,
    top_p: profile.samplingDefaults.top_p,
    max_tokens: profile.samplingDefaults.max_tokens,
    ollamaOptions: profile.ollamaOptions,
  });
  const latencyMs = Date.now() - t0;

  console.log(`\n[smoke-e0] Latency: ${latencyMs}ms`);
  console.log(`[smoke-e0] finish_reason: ${response.finishReason ?? "(not provided)"}`);
  console.log(`[smoke-e0] truncated flag: ${response.truncated ?? false}`);
  console.log(`[smoke-e0] Tokens — prompt: ${response.usage?.promptTokens ?? "?"}, completion: ${response.usage?.completionTokens ?? "?"}`);
  console.log(`\n--- Raw response (first 500 chars) ---`);
  console.log(response.rawContent.slice(0, 500));
  console.log("---");

  // Parse reasoning
  const parsed = handler.parse(response.rawContent);
  const hasReasoning = parsed.hasReasoning;
  const reasoningLen = parsed.reasoning?.length ?? 0;
  const answerLen = parsed.answer.length;

  console.log(`\n[smoke-e0] Has <think> block: ${hasReasoning}`);
  if (hasReasoning) {
    console.log(`[smoke-e0] Reasoning length: ${reasoningLen} chars`);
    console.log(`[smoke-e0] Answer length:    ${answerLen} chars`);
    console.log(`\n--- Stripped answer ---`);
    console.log(parsed.answer.slice(0, 300));
    console.log("---");
  }

  // Checks
  const failures: string[] = [];

  if (response.truncated) {
    failures.push("FAIL: finish_reason=length → completion was truncated by token budget");
  }

  if (!response.rawContent.trim()) {
    failures.push("FAIL: empty response from model");
  }

  if (hasReasoning && parsed.answer === "") {
    failures.push("FAIL: think-only output — model emitted reasoning but no answer. Likely num_ctx too small or max_tokens too low.");
  }

  // Check VibeThinker emitted <think> tags (it almost always does)
  if (!hasReasoning) {
    console.log("[smoke-e0] WARN: no <think> block in response. VibeThinker-3B usually emits one. May be a temperature/prompt issue.");
  }

  // Check token budget headroom
  const completionTokens = response.usage?.completionTokens ?? 0;
  const budget = profile.samplingDefaults.max_tokens;
  if (completionTokens > 0 && completionTokens >= budget * 0.9) {
    failures.push(`FAIL: completion used ${completionTokens}/${budget} tokens (≥90% of budget). Increase max_tokens.`);
  }

  if (failures.length > 0) {
    console.error("\n[smoke-e0] FAILURES:");
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    process.exit(1);
  }

  console.log("\n[smoke-e0] PASS — connection, reasoning split, and truncation checks all green.");
}

main().catch((err: unknown) => {
  console.error("[smoke-e0] ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
