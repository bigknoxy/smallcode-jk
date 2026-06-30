import type { ModelRegistry } from "@/models/registry.ts";
import type { Provider } from "@/provider/types.ts";
import type { EscalationRung } from "./bestofn-loop.ts";

/**
 * R1 model-escalation ladder.
 *
 * Parses a `SMALLCODE_ESCALATION` spec — a comma-separated list of model ids,
 * cheapest first, e.g. `qwen2.5-coder:3b,qwen2.5-coder:3b,qwen2.5-coder:7b` —
 * into the per-attempt rungs consumed by `runBestOfNLoop({ models })`. The
 * Best-of-N seam resolves on the FIRST oracle-green attempt, so a run only pays
 * for a bigger model when the cheaper attempts failed: 3b→3b→7b spends the 7b
 * solely on the residual the 3b couldn't solve, with zero selection error.
 *
 * All rungs share the base `provider` — local models live behind one Ollama
 * endpoint and are selected per-request by model id — so escalation never leaves
 * the machine (the offline thesis holds; cap the ladder at the largest LOCAL
 * model, e.g. qwen2.5-coder-14b). Each id is resolved through the registry, so an
 * unknown id throws here (a clear config error) rather than at request time.
 *
 * Returns `undefined` when the spec is empty/unset → callers fall back to plain
 * temperature-swept Best-of-N (no behaviour change).
 */
export function buildEscalationLadder(opts: {
  spec: string | undefined;
  registry: ModelRegistry;
  provider: Provider;
}): EscalationRung[] | undefined {
  const ids = (opts.spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return undefined;
  return ids.map((id) => ({
    id,
    provider: opts.provider,
    profile: opts.registry.get(id),
  }));
}
