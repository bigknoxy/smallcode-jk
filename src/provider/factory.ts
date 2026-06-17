import type { ProviderConfig } from "../config/types.ts";
import type { ModelRegistry } from "../models/registry.ts";
import { OpenAICompatibleClient } from "./openai-client.ts";
import type { Provider } from "./types.ts";

export function createProvider(config: ProviderConfig, _registry: ModelRegistry): Provider {
  // Currently only "openai-compatible" backend is supported
  return new OpenAICompatibleClient(config);
}
