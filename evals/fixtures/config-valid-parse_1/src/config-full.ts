import { z } from "zod";

export const FullConfigSchema = z.object({
  provider: z.object({
    baseUrl: z.string(),
    apiKey: z.string().default("none"),
    timeoutMs: z.number().default(120000),
  }),
  activeModel: z.string(),
  maxTurns: z.number().default(15),
});

export function parseFullConfig(raw: unknown) {
  return FullConfigSchema.safeParse(raw);
}
