#!/usr/bin/env bun
/**
 * Metrics trend viewer — reads evals/metrics-history.jsonl and displays
 * per-suite trend tables with regression and saturation warnings.
 *
 * Usage:
 *   bun scripts/show-metrics.ts [suiteId]
 *
 * If suiteId is given, shows only that suite.
 * Otherwise, shows all suites found in history.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MetricsSnapshot } from "../src/improve/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const METRICS_PATH = join(PROJECT_ROOT, "evals", "metrics-history.jsonl");

const REGRESSION_THRESHOLD = 0.05;
const SATURATION_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padStart(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatRunId(runId: string): string {
  return runId.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Read metrics history
// ---------------------------------------------------------------------------

async function readMetricsHistory(): Promise<MetricsSnapshot[]> {
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
      if (typeof parsed === "object" && parsed !== null) {
        results.push(parsed as MetricsSnapshot);
      }
    } catch {
      // Skip corrupt lines
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Trend table for a single suite
// ---------------------------------------------------------------------------

function printSuiteTrend(suiteId: string, snapshots: MetricsSnapshot[]): void {
  if (snapshots.length === 0) {
    console.log(`  (no data)\n`);
    return;
  }

  const COL1 = 10; // date
  const COL2 = 10; // runId
  const COL3 = 12; // passAt1
  const COL4 = 18; // tasks passed
  const COL5 = 24; // modelId

  const sep =
    `${"-".repeat(COL1)}-+-${"-".repeat(COL2)}-+-${"-".repeat(COL3)}-+-${"-".repeat(COL4)}-+-${"-".repeat(COL5)}`;

  console.log(
    `${padEnd("date", COL1)} | ${padEnd("runId", COL2)} | ${padEnd("passAt1", COL3)} | ${padEnd("tasks passed", COL4)} | ${"modelId"}`,
  );
  console.log(sep);

  for (const snap of snapshots) {
    const date = formatDate(snap.timestamp);
    const runId = formatRunId(snap.runId);
    const passAt1 = snap.overallPassAt1.toFixed(3);
    const tasks = `${snap.totalTasksPassed}/${snap.totalTasks}`;
    const modelId = snap.modelId.slice(0, COL5);

    console.log(
      `${padEnd(date, COL1)} | ${padEnd(runId, COL2)} | ${padStart(passAt1, COL3)} | ${padStart(tasks, COL4)} | ${modelId}`,
    );
  }

  console.log(sep);

  // Regression check: compare latest vs previous
  if (snapshots.length >= 2) {
    const latest = snapshots[snapshots.length - 1];
    const previous = snapshots[snapshots.length - 2];
    if (latest !== undefined && previous !== undefined) {
      const delta = latest.overallPassAt1 - previous.overallPassAt1;
      if (delta < -REGRESSION_THRESHOLD) {
        console.log(
          `\nWARNING: REGRESSION DETECTED for suite "${suiteId}"`,
        );
        console.log(
          `  pass@1 dropped from ${previous.overallPassAt1.toFixed(3)} to ${latest.overallPassAt1.toFixed(3)} (delta=${delta.toFixed(3)}, threshold=-${REGRESSION_THRESHOLD})`,
        );
      }

      // Saturation check
      if (latest.overallPassAt1 > SATURATION_THRESHOLD) {
        const pct = (latest.overallPassAt1 * 100).toFixed(1);
        console.log(
          `\nSATURATION WARNING: capability suite pass@1 is ${pct}% — add harder tasks`,
        );
      }
    }
  } else if (snapshots.length === 1) {
    const latest = snapshots[0];
    if (latest !== undefined && latest.overallPassAt1 > SATURATION_THRESHOLD) {
      const pct = (latest.overallPassAt1 * 100).toFixed(1);
      console.log(
        `\nSATURATION WARNING: capability suite pass@1 is ${pct}% — add harder tasks`,
      );
    }
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const filterSuiteId = process.argv[2];

  console.log("[show-metrics] Reading metrics history...");

  const allSnapshots = await readMetricsHistory();

  if (allSnapshots.length === 0) {
    console.log("[show-metrics] No metrics history found in evals/metrics-history.jsonl");
    console.log("[show-metrics] Run the baseline script first: SMALLCODE_DRY_RUN=1 bun scripts/run-baseline.ts");
    process.exit(0);
  }

  // Group by suiteId
  const bySuite = new Map<string, MetricsSnapshot[]>();
  for (const snap of allSnapshots) {
    const existing = bySuite.get(snap.suiteId) ?? [];
    existing.push(snap);
    bySuite.set(snap.suiteId, existing);
  }

  const suiteIds = filterSuiteId ? [filterSuiteId] : Array.from(bySuite.keys());

  if (filterSuiteId && !bySuite.has(filterSuiteId)) {
    console.log(`[show-metrics] No data found for suite: ${filterSuiteId}`);
    console.log(`[show-metrics] Available suites: ${Array.from(bySuite.keys()).join(", ")}`);
    process.exit(0);
  }

  console.log(
    `[show-metrics] Found ${allSnapshots.length} snapshot(s) across ${bySuite.size} suite(s)\n`,
  );

  for (const suiteId of suiteIds) {
    const snapshots = bySuite.get(suiteId) ?? [];
    console.log(`Suite: ${suiteId} (${snapshots.length} run(s))`);
    printSuiteTrend(suiteId, snapshots);
  }
}

main().catch((err: unknown) => {
  console.error(
    "[show-metrics] ERROR:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
