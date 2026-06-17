#!/usr/bin/env bun
/**
 * Regression gate — compares the last 2 entries for a given suiteId from
 * evals/metrics-history.jsonl and exits 1 if pass@1 dropped more than 0.05.
 *
 * Usage:
 *   bun scripts/regression-gate.ts <suiteId>
 *
 * Exit codes:
 *   0 — no regression (or no baseline to compare against)
 *   1 — regression detected (pass@1 dropped > 0.05)
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MetricsSnapshot } from "../src/improve/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const METRICS_PATH = join(PROJECT_ROOT, "evals", "metrics-history.jsonl");

const REGRESSION_DELTA = 0.05;

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

async function readSnapshots(suiteId: string): Promise<MetricsSnapshot[]> {
  let raw: string;
  try {
    raw = await readFile(METRICS_PATH, "utf-8");
  } catch {
    return [];
  }

  const results: MetricsSnapshot[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>)["suiteId"] === suiteId
      ) {
        results.push(parsed as MetricsSnapshot);
      }
    } catch {
      // Skip corrupt lines
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const suiteId = process.argv[2];

  if (!suiteId) {
    console.error("Usage: bun scripts/regression-gate.ts <suiteId>");
    process.exit(1);
  }

  console.log(`[regression-gate] Checking suite: ${suiteId}`);

  const snapshots = await readSnapshots(suiteId);

  if (snapshots.length === 0) {
    console.log(`[regression-gate] No history found for suite "${suiteId}". First run — gate passes.`);
    process.exit(0);
  }

  if (snapshots.length === 1) {
    const snap = snapshots[0];
    if (snap !== undefined) {
      console.log(
        `[regression-gate] Only one entry found (runId=${snap.runId}, pass@1=${snap.overallPassAt1.toFixed(3)}). No baseline to compare — gate passes.`,
      );
    }
    process.exit(0);
  }

  // Get last 2 entries
  const previous = snapshots[snapshots.length - 2];
  const latest = snapshots[snapshots.length - 1];

  if (previous === undefined || latest === undefined) {
    console.log("[regression-gate] Insufficient data — gate passes.");
    process.exit(0);
  }

  const delta = latest.overallPassAt1 - previous.overallPassAt1;

  console.log(`[regression-gate] Previous run: ${previous.runId.slice(0, 8)} pass@1=${previous.overallPassAt1.toFixed(3)}`);
  console.log(`[regression-gate] Latest run:   ${latest.runId.slice(0, 8)} pass@1=${latest.overallPassAt1.toFixed(3)}`);
  console.log(
    `[regression-gate] Delta: ${delta >= 0 ? "+" : ""}${delta.toFixed(3)} (threshold: -${REGRESSION_DELTA})`,
  );

  if (delta < -REGRESSION_DELTA) {
    console.error(
      `\n[regression-gate] FAILED: pass@1 dropped by ${Math.abs(delta).toFixed(3)}, which exceeds the allowed regression of ${REGRESSION_DELTA}.`,
    );
    console.error(
      `[regression-gate] Suite "${suiteId}": ${previous.overallPassAt1.toFixed(3)} → ${latest.overallPassAt1.toFixed(3)}`,
    );

    // Show per-task regressions if available
    const regressedTasks: string[] = [];
    for (const [taskId, latestScore] of Object.entries(latest.perTaskPassAt1)) {
      const prevScore = previous.perTaskPassAt1[taskId];
      if (prevScore !== undefined && latestScore < prevScore) {
        regressedTasks.push(
          `  ${taskId}: ${prevScore.toFixed(2)} → ${latestScore.toFixed(2)}`,
        );
      }
    }

    if (regressedTasks.length > 0) {
      console.error("\n[regression-gate] Regressed tasks:");
      for (const line of regressedTasks) {
        console.error(line);
      }
    }

    process.exit(1);
  }

  console.log(`\n[regression-gate] PASSED: no significant regression detected for suite "${suiteId}".`);
}

main().catch((err: unknown) => {
  console.error(
    "[regression-gate] ERROR:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
