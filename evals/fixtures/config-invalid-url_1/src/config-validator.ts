import { z } from "zod";

const ProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().default("none"),
});

export function validateProviderConfig(raw: unknown) {
  return ProviderSchema.safeParse(raw);
}
