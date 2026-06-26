#!/usr/bin/env bun
/**
 * compare-runs.ts — auto-judge two eval runs by confidence-interval overlap.
 *
 * The measuring stick (PR #26) reports pass@k with 95% bootstrap CIs. Reading
 * an A/B by eye is slow and error-prone; this turns it into a one-command
 * verdict: for each k (and per task), is the difference SIGNIFICANT (CIs don't
 * overlap) or not (they do — raise n)?
 *
 * Usage:
 *   bun scripts/compare-runs.ts                 # last two live runs in history
 *   bun scripts/compare-runs.ts <runIdA> <runIdB>
 *   bun scripts/compare-runs.ts --file a.json b.json   # two snapshot json files
 *
 * Reads evals/metrics-history.jsonl (one MetricsSnapshot per line). The two
 * arms of an A/B (e.g. max_tokens=4096 vs 6144) are two consecutive live runs.
 *
 * NOTE: CI-overlap is a CONSERVATIVE test — non-overlap ⇒ significant at ~0.05,
 * but overlap does NOT prove "no effect" (it means this n can't resolve it).
 */

import { resolve } from "node:path";
import type { MetricsSnapshot, SnapshotCI } from "../src/improve/types.ts";

const HISTORY = resolve(import.meta.dir, "..", "evals", "metrics-history.jsonl");

async function readSnapshots(): Promise<MetricsSnapshot[]> {
  const text = await Bun.file(HISTORY).text();
  const out: MetricsSnapshot[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as MetricsSnapshot);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function label(s: MetricsSnapshot): string {
  const samp = s.sampling ?? {};
  const bits: string[] = [];
  if (samp.maxTokens !== undefined) bits.push(`max_tokens=${samp.maxTokens}`);
  if (samp.temp !== undefined) bits.push(`temp=${samp.temp}`);
  const cfg = bits.length ? bits.join(" ") : "default sampling";
  const when = new Date(s.timestamp).toISOString().slice(0, 16).replace("T", " ");
  const model = s.modelId ? `${s.modelId} · ` : "";
  return `${model}${cfg}  (n=${s.n ?? "?"}, ${when}, ${s.runId})`;
}

/** Two 95% CIs are significantly different iff they do NOT overlap. */
function overlap(a: SnapshotCI, b: SnapshotCI): boolean {
  return !(a.hi < b.lo || b.hi < a.lo);
}

function fmtCI(p: number | undefined, ci: SnapshotCI | undefined): string {
  if (p === undefined) return "  —   ";
  const b = (x: number) => x.toFixed(2).replace(/^0(?=\.)/, "");
  return ci ? `${p.toFixed(2)}[${b(ci.lo)}-${b(ci.hi)}]` : p.toFixed(2);
}

function verdict(
  pa: number | undefined,
  ca: SnapshotCI | undefined,
  pb: number | undefined,
  cb: SnapshotCI | undefined,
): string {
  if (pa === undefined || pb === undefined) return "";
  if (ca && cb && !overlap(ca, cb)) {
    return pb > pa ? "▲ SIGNIFICANT (B better)" : "▼ SIGNIFICANT (B worse)";
  }
  const d = pb - pa;
  const arrow = d > 0.001 ? "↑" : d < -0.001 ? "↓" : "=";
  return `ns ${arrow}${Math.abs(d).toFixed(2)} (CIs overlap — raise n)`;
}

function compareKs(a: MetricsSnapshot, b: MetricsSnapshot): number[] {
  const ka = a.reportKs ?? Object.keys(a.overallPassAtK ?? {}).map(Number);
  const kb = new Set(b.reportKs ?? Object.keys(b.overallPassAtK ?? {}).map(Number));
  return [...new Set(ka)].filter((k) => kb.has(k)).sort((x, y) => x - y);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printComparison(a: MetricsSnapshot, b: MetricsSnapshot): void {
  console.log(`\nA: ${label(a)}`);
  console.log(`B: ${label(b)}`);
  console.log(`suite: ${a.suiteId}${a.suiteId !== b.suiteId ? ` vs ${b.suiteId} ⚠ different suites!` : ""}`);

  const ks = compareKs(a, b);
  if (ks.length === 0) {
    console.log("\n(no comparable pass@k — were these old snapshots without CI fields?)");
    return;
  }

  // Overall (pooled) — the headline.
  console.log(`\n${"═".repeat(78)}\nOVERALL (pooled)\n${"─".repeat(78)}`);
  for (const k of ks) {
    const pa = a.overallPassAtK?.[k];
    const ca = a.overallCI?.[k];
    const pb = b.overallPassAtK?.[k];
    const cb = b.overallCI?.[k];
    console.log(
      `  pass@${k}  A ${pad(fmtCI(pa, ca), 16)} B ${pad(fmtCI(pb, cb), 16)}  ${verdict(pa, ca, pb, cb)}`,
    );
  }

  // Per task.
  const taskIds = [...new Set([...Object.keys(a.perTaskPassAtK ?? {}), ...Object.keys(b.perTaskPassAtK ?? {})])].sort();
  if (taskIds.length) {
    console.log(`\n${"─".repeat(78)}\nPer task\n${"─".repeat(78)}`);
    for (const id of taskIds) {
      console.log(`  ${id}`);
      for (const k of ks) {
        const pa = a.perTaskPassAtK?.[id]?.[k];
        const ca = a.perTaskCI?.[id]?.[k];
        const pb = b.perTaskPassAtK?.[id]?.[k];
        const cb = b.perTaskCI?.[id]?.[k];
        if (pa === undefined && pb === undefined) continue;
        console.log(
          `      pass@${k}  A ${pad(fmtCI(pa, ca), 16)} B ${pad(fmtCI(pb, cb), 16)}  ${verdict(pa, ca, pb, cb)}`,
        );
      }
    }
  }

  // Side metrics.
  const toA = a.thinkOnlyTotal ?? undefined;
  const toB = b.thinkOnlyTotal ?? undefined;
  if (toA !== undefined || toB !== undefined) {
    console.log(`\n${"─".repeat(78)}`);
    console.log(`  think-only truncations:  A=${toA ?? "?"}  B=${toB ?? "?"}`);
  }
  console.log(
    "\nVerdict rule: CIs that do NOT overlap ⇒ significant (~p<0.05). Overlap ⇒ this n cannot resolve it; raise SMALLCODE_EVAL_N.\n",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "--file") {
    const a = JSON.parse(await Bun.file(args[1] ?? "").text()) as MetricsSnapshot;
    const b = JSON.parse(await Bun.file(args[2] ?? "").text()) as MetricsSnapshot;
    printComparison(a, b);
    return;
  }

  const snaps = await readSnapshots();
  const live = snaps.filter((s) => s.runId.startsWith("live-"));

  let a: MetricsSnapshot | undefined;
  let b: MetricsSnapshot | undefined;
  if (args.length >= 2) {
    a = snaps.find((s) => s.runId === args[0]);
    b = snaps.find((s) => s.runId === args[1]);
    if (!a || !b) {
      console.error(`Could not find both runIds. Available live runs:\n${live.map((s) => `  ${s.runId}  ${label(s)}`).join("\n")}`);
      process.exit(1);
    }
  } else {
    // default: the last two live runs (A = older, B = newer)
    if (live.length < 2) {
      console.error(`Need ≥2 live runs in history; found ${live.length}.`);
      process.exit(1);
    }
    a = live[live.length - 2];
    b = live[live.length - 1];
  }
  printComparison(a as MetricsSnapshot, b as MetricsSnapshot);
}

main().catch((err: unknown) => {
  console.error("[compare-runs] ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
