import type { ProviderConfig } from "../config/types.ts";
import type { ModelRegistry } from "../models/registry.ts";
import { OpenAICompatibleClient } from "./openai-client.ts";
import type { Provider } from "./types.ts";
import { maybeWrapWatchdog } from "./watchdog.ts";

export function createProvider(config: ProviderConfig, _registry: ModelRegistry): Provider {
  // Currently only "openai-compatible" backend is supported
  const base = new OpenAICompatibleClient(config);
  // Wrap with throughput watchdog to detect KV-cache fragmentation decay.
  // Controlled by SMALLCODE_WATCHDOG env var (default ON; set to "0" to disable).
  return maybeWrapWatchdog(base);
}
