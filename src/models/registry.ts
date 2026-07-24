import type { ModelProfile } from "./types.ts";

const BUILT_IN_PROFILES: ModelProfile[] = [
  {
    id: "vibethinker-3b",
    label: "WeiboAI/VibeThinker-3B",
    contextWindow: 65_536,
    samplingDefaults: {
      temperature: 1.0,
      top_p: 0.95,
      top_k: -1,
      max_tokens: 4_096,
    },
    reasoningTags: { open: "<think>", close: "</think>" },
    supportsGrammar: false,
    supportsJsonSchema: false,
    // Ollama defaults num_ctx to 2048; 8K is sufficient for task prompt + CoT + answer.
    // 32K was causing memory pressure/swap on the eval machine, dropping speed from 44→3 tok/s.
    // top_k=-1 requires a Modelfile PARAMETER — the OpenAI-compat route silently ignores it.
    ollamaOptions: { num_ctx: 8_192 },
    notes:
      "Qwen2.5-3B base, MIT license. Strong at verifiable code/math, weak at open-domain knowledge. High variance — use best-of-N. top_k=-1 requires Modelfile (not settable via OpenAI-compat route).",
  },
  {
    // NOTE: id MUST equal the Ollama model name (the provider sends it verbatim to
    // /v1). Qwen2.5-Coder-Instruct is a NON-reasoning model — no <think> traces, so
    // think-only truncation physically cannot occur. This is the control arm for the
    // "is VibeThinker's reasoning training the root cause of the truncation spiral?"
    // experiment. num_ctx + max_tokens matched to vibethinker-3b so the A/B isolates
    // the MODEL; sampling is Qwen's own recommended coding config (temp 0.7 gives
    // pass@k trial diversity without the temp=1.0 spiral). Keeps "harness > model
    // size" honest: same 3B size class as VibeThinker.
    id: "qwen2.5-coder:3b",
    label: "Qwen/Qwen2.5-Coder-3B-Instruct",
    contextWindow: 32_768,
    samplingDefaults: {
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      max_tokens: 4_096,
    },
    supportsGrammar: true,
    supportsJsonSchema: true,
    // No reasoningTags: non-reasoning instruct model emits the answer directly.
    ollamaOptions: { num_ctx: 8_192 },
    notes:
      "Qwen2.5-Coder-3B-Instruct, Apache-2.0. Control arm vs vibethinker-3b: same size, no <think> reasoning, so no truncation spiral. Recommended sampling temp 0.7 / top_p 0.8 / top_k 20.",
  },
  {
    // id = the Ollama model name so the provider can reach it. Same non-reasoning
    // family as the 3B, one size up — the larger arm of the 3-way model comparison.
    // num_ctx + sampling matched to qwen2.5-coder:3b for a fair size A/B.
    id: "qwen2.5-coder:7b",
    label: "Qwen/Qwen2.5-Coder-7B-Instruct",
    contextWindow: 32_768,
    samplingDefaults: {
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      max_tokens: 4_096,
    },
    supportsGrammar: true,
    supportsJsonSchema: true,
    ollamaOptions: { num_ctx: 8_192 },
    notes: "Qwen2.5-Coder-7B-Instruct, Apache-2.0. Larger arm of the 3-way comparison.",
  },
  {
    // Strong reflector for the GEPA loop (frontier-reflector -> 3B-target design).
    // Not an executor arm — used by LLMReflectiveMutator to rewrite the weak
    // target's system prompt from failed transcripts. Bigger num_ctx (it reads
    // multiple full failed transcripts) and bigger max_tokens (it re-emits whole
    // prompt blocks). Slow on a single GPU but invoked only ~once per generation.
    id: "qwen2.5-coder:32b",
    label: "Qwen/Qwen2.5-Coder-32B-Instruct",
    contextWindow: 32_768,
    samplingDefaults: {
      temperature: 0.6,
      top_p: 0.9,
      top_k: 20,
      max_tokens: 8_192,
    },
    supportsGrammar: true,
    supportsJsonSchema: true,
    ollamaOptions: { num_ctx: 16_384 },
    notes:
      "Qwen2.5-Coder-32B-Instruct, Apache-2.0. GEPA reflection model — strong build-time prompt optimizer for a weak (3B) runtime target.",
  },
  {
    id: "qwen2.5-coder-14b",
    label: "Qwen/Qwen2.5-Coder-14B-Instruct",
    contextWindow: 131_072,
    samplingDefaults: {
      temperature: 0.7,
      top_p: 0.95,
      top_k: -1,
      max_tokens: 4_096,
    },
    supportsGrammar: true,
    supportsJsonSchema: true,
  },
  {
    // A non-Qwen escalation rung for users with bigger hardware: the R1 ladder is
    // model-agnostic, so any registered local model is a valid top rung (the
    // offline thesis holds — still one Ollama endpoint). id = the Ollama model
    // name. Gemma is a non-reasoning instruct model (no <think>), large window.
    id: "gemma4:12b",
    label: "Google/Gemma-12B-Instruct",
    contextWindow: 131_072,
    samplingDefaults: {
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      max_tokens: 4_096,
    },
    supportsGrammar: false,
    supportsJsonSchema: true,
    ollamaOptions: { num_ctx: 8_192 },
    notes:
      "Gemma 12B instruct (non-reasoning), via Ollama. Optional higher escalation rung for users with bigger hardware — the R1 ladder accepts any registered local model.",
  },
  {
    // Experimental probe (ref_qwythos_9b_plan): Qwen3.5-9B finetune, Claude-distilled,
    // Apache-2.0. Served via llama-server (OpenAI-compat at :8910/v1), NOT Ollama —
    // point smallcode at it with SMALLCODE_BASE_URL=http://localhost:8910/v1. id MUST
    // equal llama-server's --alias (sent verbatim to /v1). Reasoning model (<think>).
    // ollamaOptions.num_ctx is inert here (that's Ollama's route) — context is fixed at
    // llama-server serve time (--ctx-size 16384, NOT 1M: over-retrieval hurts, see
    // project_context_window_ab). DO NOT use MTP spec-decode on Metal (net-loss,
    // llama.cpp #23752). GATE: run a 10-task edit-format smoke first; abort if <~90%.
    id: "qwythos-9b",
    label: "empero-ai/Qwythos-9B-Claude-Mythos-5 (Qwen3.5-9B finetune)",
    contextWindow: 16_384,
    samplingDefaults: {
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      max_tokens: 4_096,
    },
    reasoningTags: { open: "<think>", close: "</think>" },
    supportsGrammar: false,
    supportsJsonSchema: false,
    notes:
      "Qwen3.5-9B finetune, Claude-distilled, Apache-2.0. Served via llama-server (OpenAI-compat :8910/v1), NOT Ollama. Reasoning model (<think>). Serve WITHOUT MTP spec-decode on Metal (net-loss) and ctx 16k not 1M. Experimental A/B probe vs qwen2.5-coder:7b — gate on edit-format ≥90% first. See ref_qwythos_9b_plan.",
  },
];

export class ModelRegistry {
  private readonly profiles: Map<string, ModelProfile>;

  constructor(extra: ModelProfile[] = []) {
    this.profiles = new Map(BUILT_IN_PROFILES.map((p) => [p.id, p]));
    for (const p of extra) {
      this.profiles.set(p.id, p);
    }
  }

  get(id: string): ModelProfile {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(
        `Unknown model profile: "${id}". Known: ${[...this.profiles.keys()].join(", ")}`,
      );
    }
    return profile;
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  list(): ModelProfile[] {
    return [...this.profiles.values()];
  }

  register(profile: ModelProfile): void {
    this.profiles.set(profile.id, profile);
  }
}

export const defaultRegistry = new ModelRegistry();

/**
 * Validate a model id against the registry (E2-T4): catch a typo'd/absent id at
 * config time instead of at the first inference. Returns a clean, actionable
 * message listing the known ids on failure. Pure; exported for testing.
 */
export function validateModelId(
  id: string,
  registry: ModelRegistry,
): { ok: boolean; message?: string } {
  if (registry.has(id)) return { ok: true };
  const known = registry
    .list()
    .map((p) => p.id)
    .join(", ");
  return {
    ok: false,
    message:
      `Unknown model id "${id}". Known ids: ${known}. ` +
      `Pick one of those, or add a custom profile under "models" in your config.`,
  };
}
