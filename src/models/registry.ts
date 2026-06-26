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
    id: "qwen2.5-coder-7b",
    label: "Qwen/Qwen2.5-Coder-7B-Instruct",
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
