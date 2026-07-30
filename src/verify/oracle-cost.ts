/**
 * Oracle cost measuring stick (E6-T1).
 *
 * The oracle spawns the WHOLE `bun test` suite on every invocation, and it is
 * invoked from five distinct places (pre-loop baseline, per-turn verdict, the
 * final-state guard, the guard's restore verification, and once per repair
 * candidate). Before optimizing any of that we need a before-number — total
 * calls, total wall-clock, and the split by call site — so an "it got faster"
 * claim can be checked instead of believed.
 *
 * Pure accounting: recording a call must never change a verdict. Nothing here
 * is read by `solved`, `regressed`, the revert gate, or repair acceptance.
 */

/** Where an oracle run was invoked from. `repair-candidate` is the hypothesised dominant cost. */
export type OracleCallSite =
  | "baseline"
  | "per-turn"
  | "final-guard"
  | "restore-verify"
  | "repair-candidate"
  | "other";

export const ORACLE_CALL_SITES: readonly OracleCallSite[] = [
  "baseline",
  "per-turn",
  "final-guard",
  "restore-verify",
  "repair-candidate",
  "other",
];

export interface OracleCallSiteStats {
  calls: number;
  totalMs: number;
}

export interface OracleCostStats {
  calls: number;
  totalMs: number;
  /** Only call sites that actually ran appear here. */
  byCallSite: Record<string, OracleCallSiteStats>;
}

// Module-local, not a global: no cross-module mutation, and a plain assignment
// resets it deterministically across bun versions.
let calls = 0;
let totalMs = 0;
let byCallSite: Record<string, OracleCallSiteStats> = {};

/** Record one oracle (`bun test`) invocation. Accounting only — never affects a verdict. */
export function recordOracleCall(callSite: OracleCallSite, durationMs: number): void {
  calls++;
  totalMs += durationMs;
  const row = (byCallSite[callSite] ??= { calls: 0, totalMs: 0 });
  row.calls++;
  row.totalMs += durationMs;
}

/** Snapshot of the counters. Returns a deep copy — callers cannot mutate the accumulator. */
export function getOracleCostStats(): OracleCostStats {
  const copy: Record<string, OracleCallSiteStats> = {};
  for (const [k, v] of Object.entries(byCallSite)) copy[k] = { calls: v.calls, totalMs: v.totalMs };
  return { calls, totalMs, byCallSite: copy };
}

/** Zero the counters (per-run reporting, and test isolation). */
export function resetOracleCostStats(): void {
  calls = 0;
  totalMs = 0;
  byCallSite = {};
}

/**
 * Human-readable cost table. Rows are sorted by total time descending so the
 * dominant call site is the first thing read. Returns null when no oracle ran,
 * so callers can stay silent rather than print an empty table.
 */
export function formatOracleCostReport(stats: OracleCostStats = getOracleCostStats()): string | null {
  if (stats.calls === 0) return null;
  const rows = Object.entries(stats.byCallSite).sort((a, b) => b[1].totalMs - a[1].totalMs);
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const pct = (ms: number) => (stats.totalMs === 0 ? "0%" : `${Math.round((ms / stats.totalMs) * 100)}%`);
  const lines = [
    `[oracle-cost] ${stats.calls} call(s), ${secs(stats.totalMs)} total`,
    ...rows.map(
      ([site, r]) =>
        `[oracle-cost]   ${site.padEnd(17)} ${String(r.calls).padStart(4)} call(s)  ` +
        `${secs(r.totalMs).padStart(8)}  ${pct(r.totalMs).padStart(4)}`,
    ),
  ];
  return lines.join("\n");
}
