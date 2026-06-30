import { z } from "zod";

export const ProviderConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().default("none"),
  timeoutMs: z.number().int().positive().default(120_000),
});

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(true),
  requireApproval: z.boolean().default(true),
  allowedCommands: z.array(z.string()).default(["bun", "tsc", "biome", "git"]),
  networkAccess: z.boolean().default(false),
});

export const EvalConfigSchema = z.object({
  suitesDir: z.string().default("evals/suites"),
  transcriptsDir: z.string().default("evals/transcripts"),
  defaultTrials: z.number().int().min(1).default(1),
});

export const SmallcodeConfigSchema = z.object({
  provider: ProviderConfigSchema,
  activeModel: z.string(),
  sandbox: SandboxConfigSchema.default({
    enabled: true,
    requireApproval: true,
    allowedCommands: ["bun", "tsc", "biome", "git"],
    networkAccess: false,
  }),
  eval: EvalConfigSchema.default({
    suitesDir: "evals/suites",
    transcriptsDir: "evals/transcripts",
    defaultTrials: 1,
  }),
  maxTurns: z.number().int().min(1).max(50).default(15),
  bestOfN: z.number().int().min(1).max(10).default(1),
  /**
   * R1 model-escalation ladder: model ids cheapest-first, applied across
   * Best-of-N attempts. Attempt i uses ladder[min(i, len-1)], so a run climbs
   * 3b→7b→… only on the residual the cheaper rungs couldn't solve (Best-of-N
   * resolves on the first oracle-green attempt). Every id must be a known model
   * profile. Empty/omitted → no escalation (all attempts use activeModel). A
   * low-resource user leaves this empty and runs the 3b alone; a user with bigger
   * hardware escalates as high as the box allows, e.g.
   * ["qwen2.5-coder:3b","qwen2.5-coder:7b","gemma4:12b"]. All rungs are LOCAL
   * (one Ollama endpoint) so escalation never leaves the machine.
   */
  escalation: z.array(z.string()).default([]),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type EvalConfig = z.infer<typeof EvalConfigSchema>;
export type SmallcodeConfig = z.infer<typeof SmallcodeConfigSchema>;
