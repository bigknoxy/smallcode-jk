import { z } from "zod";

export const ConfigSchema = z.object({
  provider: z.object({ baseUrl: z.string().url(), apiKey: z.string() }),
  activeModel: z.string(),
});

export function parseConfig(raw: unknown) {
  return ConfigSchema.safeParse(raw);
}
