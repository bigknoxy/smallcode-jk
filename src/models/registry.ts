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
      max_tokens: 2_048,
    },
    reasoningTags: { open: "<think>", close: "</think>" },
    supportsGrammar: false,
    supportsJsonSchema: false,
    // Ollama defaults num_ctx to 2048; 32K prevents CoT truncation.
    // top_k=-1 requires a Modelfile PARAMETER — the OpenAI-compat route silently ignores it.
    ollamaOptions: { num_ctx: 32_768 },
    notes:
      "Qwen2.5-3B base, MIT license. Strong at verifiable code/math, weak at open-domain knowledge. High variance — use best-of-N. top_k=-1 requires Modelfile (not settable via OpenAI-compat route).",
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
