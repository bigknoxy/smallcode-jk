#!/usr/bin/env bun
// E6-T1 — oracle cost measuring stick. Prints the BEFORE-number for epic E6.
//
// The oracle spawns the WHOLE `bun test` suite on every invocation, from five
// distinct call sites (pre-loop baseline, per-turn verdict, final-state guard,
// the guard's restore verification, and once per repair candidate). Nothing in
// E6 may be optimized until that cost is measured, so this script produces the
// number an "it got faster" claim will be checked against.
//
// Two modes:
//
//   bun scripts/oracle-cost-report.ts
//       Model-free. Times N full `bun test` runs of the target repo to get the
//       unit cost of ONE oracle call, then projects the per-run total from the
//       call counts a real agent run makes. Works in CI, no Ollama needed.
//
//   bun scripts/oracle-cost-report.ts --dogfood
//       Runs the real smallcode-on-own-history harness (scripts/dogfood-history.ts)
//       with the agent enabled, and reports the MEASURED call/time split by call
//       site. Needs a reachable model. This is the authoritative number. The
//       table is emitted PER TASK (counters reset before each), so the number is
//       comparable regardless of DOGFOOD_LIMIT.
//
// Env: ORACLE_COST_SAMPLES (default 3), ORACLE_COST_REPO (default this repo),
//      plus DOGFOOD_LIMIT / SMALLCODE_MODEL passed through in --dogfood mode.
import { join } from "node:path";
import { repoSubprocessEnv } from "../src/util/subprocess-env.ts";
import { formatOracleCostReport, getOracleCostStats, recordOracleCall } from "../src/verify/oracle-cost.ts";

const ROOT = join(import.meta.dir, "..");
const REPO = process.env["ORACLE_COST_REPO"] ?? ROOT;
const SAMPLES = Number(process.env["ORACLE_COST_SAMPLES"] ?? "3");

/** One real full-suite spawn, timed the same way the oracle times its own. */
function timeFullSuite(repoRoot: string): number {
  const start = Date.now();
  // Same clean env the oracle uses: never leak SMALLCODE_* into the repo's own
  // tests (that poisoned a smallcode-on-smallcode run once already).
  Bun.spawnSync(["bun", "test"], { cwd: repoRoot, timeout: 120_000, env: repoSubprocessEnv() });
  return Date.now() - start;
}

function runDogfood(): number {
  const proc = Bun.spawnSync(["bun", "scripts/dogfood-history.ts"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    timeout: 3_600_000,
    env: { ...process.env, DOGFOOD_AGENT: "1" },
  });
  return proc.exitCode ?? 1;
}

function main(): number {
  if (process.argv.includes("--dogfood")) {
    console.log("[oracle-cost] measured mode — running the dogfood harness with the agent enabled.");
    console.log("[oracle-cost] the '[oracle-cost]' table it prints at the end IS the before-number.\n");
    return runDogfood();
  }

  console.log(`[oracle-cost] model-free mode — timing ${SAMPLES} full \`bun test\` run(s) of ${REPO}.`);
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const ms = timeFullSuite(REPO);
    samples.push(ms);
    console.log(`[oracle-cost]   sample ${i + 1}: ${(ms / 1000).toFixed(1)}s`);
  }
  if (samples.length === 0) {
    console.error("[oracle-cost] no samples taken (ORACLE_COST_SAMPLES must be >= 1).");
    return 1;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const unit = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(
    `[oracle-cost] unit cost of ONE oracle call: ${(unit / 1000).toFixed(1)}s (median of ${samples.length}), ` +
      `spread ${((( sorted.at(-1) ?? 0) - (sorted[0] ?? 0)) / 1000).toFixed(1)}s\n`,
  );

  // Projection, clearly labelled as a projection — not a measurement. A run's
  // fixed floor is baseline + one per-turn verdict per turn; repair candidates
  // are the variable term and the hypothesised dominant cost.
  console.log("[oracle-cost] projected per-run cost (fixed floor, before any repair candidates):");
  for (const turns of [1, 3, 6]) {
    // baseline + one per-turn verdict per turn. An unsolved run additionally
    // pays the final-state guard and its restore verification (2 more calls),
    // so both bounds are printed rather than only the optimistic one.
    const calls = 1 + turns;
    const withGuard = calls + 2;
    console.log(
      `[oracle-cost]   ${turns} turn(s): ${calls} call(s) ≈ ${((calls * unit) / 1000).toFixed(1)}s solved, ` +
        `${withGuard} call(s) ≈ ${((withGuard * unit) / 1000).toFixed(1)}s unsolved (guard + restore-verify). ` +
        "Excludes every repair candidate.",
    );
  }
  console.log(
    "\n[oracle-cost] this is a PROJECTION. For the measured split by call site, run:\n" +
      "[oracle-cost]   bun scripts/oracle-cost-report.ts --dogfood",
  );

  // Demonstrate the accounting path end-to-end on the samples just taken, so the
  // table format in this report is the same one a real run prints.
  for (const ms of samples) recordOracleCall("baseline", ms);
  const table = formatOracleCostReport(getOracleCostStats());
  if (table) console.log(`\n[oracle-cost] (sample runs, accounted through the real counters)\n${table}`);
  return 0;
}

if (import.meta.main) process.exit(main());
