/**
 * Env for a subprocess that runs the REPO-UNDER-REPAIR's own tests/commands.
 * Strips the harness's own `SMALLCODE_*` control-plane vars (model routing +
 * config overrides like `SMALLCODE_BASE_URL` / `SMALLCODE_MODEL`) so they can't
 * leak into and contaminate the target repo's test oracle.
 *
 * Surfaced by dogfooding smallcode ON smallcode: `smallcode run` sets
 * `SMALLCODE_BASE_URL`/`SMALLCODE_MODEL` to reach the model, the oracle spawns
 * `bun test`, and smallcode's OWN config tests read those vars via
 * `applyEnvOverrides` and flip red — so a CORRECT fix was reported as "still
 * failing" and every dogfood run on config/env code was unsolvable. A
 * non-smallcode repo never reads `SMALLCODE_*`, so this is a no-op there (which
 * is exactly why the fixture-repo benchmark never caught it).
 *
 * Lives in `util/` (no deps) so both the agent tool layer and the verify oracle
 * can import it without an agent↔verify cycle.
 */
export function repoSubprocessEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith("SMALLCODE_")) continue;
    out[k] = v;
  }
  return out;
}
