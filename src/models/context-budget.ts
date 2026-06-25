import type { ModelProfile } from "./types.ts";

// The context-budget math lives here so the CLI (run.ts), the agent loop's
// pre-flight guard, and the eval harness all derive the SAME numbers from a
// single model profile. The bug this fixes: budgeting repo context off the
// nominal `contextWindow` (65_536 for vibethinker) while Ollama actually runs
// the model at `num_ctx` (8_192) — a 4x overshoot that overflowed the window
// and returned HTTP 400 after a few turns.

/**
 * The context window Ollama will ACTUALLY use for this model. `num_ctx` (when
 * set in the profile's ollamaOptions) overrides the nominal `contextWindow`,
 * because that is the value passed to Ollama and it is what bounds the real
 * KV-cache / prompt+generation budget. Falls back to `contextWindow` when no
 * Ollama override is present.
 */
export function effectiveContextWindow(profile: ModelProfile): number {
  return profile.ollamaOptions?.num_ctx ?? profile.contextWindow;
}

/**
 * Hard ceiling for the assembled prompt (system + user message). The model
 * needs `max_tokens` of the window reserved for its own generation; anything
 * above this ceiling either truncates the completion (think-only failure) or
 * makes Ollama reject the request with HTTP 400. The loop trims repo context
 * until the prompt fits under this number.
 */
export function promptHardCap(profile: ModelProfile): number {
  const window = effectiveContextWindow(profile);
  return Math.max(1024, window - profile.samplingDefaults.max_tokens);
}

/**
 * Token budget handed to buildContext() for repo-context retrieval. Identical
 * to the prompt hard cap: repo content must fit the same window-minus-generation
 * space, and buildContext() reserves a further ~2048 tokens internally for the
 * prompt scaffolding (system prompt + task + recent history).
 */
export function contextBudgetFor(profile: ModelProfile): number {
  return promptHardCap(profile);
}
