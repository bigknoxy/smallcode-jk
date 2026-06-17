import { z } from "zod";

export const ReasoningTagSchema = z.object({
  open: z.string(),
  close: z.string(),
});

export const SamplingDefaultsSchema = z.object({
  temperature: z.number().min(0).max(2),
  top_p: z.number().min(0).max(1),
  top_k: z.number().int().min(-1),
  max_tokens: z.number().int().positive(),
});

export const OllamaOptionsSchema = z
  .object({
    num_ctx: z.number().int().positive().optional(),
    num_predict: z.number().int().optional(),
    top_k: z.number().int().optional(),
  })
  .strict();

export const ModelProfileSchema = z.object({
  id: z.string(),
  label: z.string(),
  contextWindow: z.number().int().positive(),
  samplingDefaults: SamplingDefaultsSchema,
  reasoningTags: ReasoningTagSchema.optional(),
  supportsGrammar: z.boolean().default(false),
  supportsJsonSchema: z.boolean().default(false),
  ollamaOptions: OllamaOptionsSchema.optional(),
  notes: z.string().optional(),
});

export type ReasoningTags = z.infer<typeof ReasoningTagSchema>;
export type SamplingDefaults = z.infer<typeof SamplingDefaultsSchema>;
export type OllamaOptions = z.infer<typeof OllamaOptionsSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
