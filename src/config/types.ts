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
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type EvalConfig = z.infer<typeof EvalConfigSchema>;
export type SmallcodeConfig = z.infer<typeof SmallcodeConfigSchema>;
