#!/usr/bin/env bun
/**
 * Re-run only the HumanEval problems whose trials hit `trial timeout` in a
 * marathon run, with a FRESH Ollama and a higher per-trial cap. Isolates true
 * model capability from infra slowdown (a long run drifts Ollama generation
 * slower until trials blow the default 10-min cap — those failures are infra,
 * not the model getting wrong answers).
 *
 * Usage:
 *   bun scripts/rerun-timeouts.ts [logPath]
 *   SMALLCODE_RERUN_TIMEOUT_MS=1200000  (per-trial cap, default 20min)
 *   SMALLCODE_HE_K=3
 *
 * Restart Ollama first:  ollama stop vibethinker-3b ; (it reloads on next call)
 */
import { readFileSync } from "node:fs";

const LOG = process.argv[2] ?? "/tmp/humaneval-full.log";
const K = process.env.SMALLCODE_HE_K ?? "3";
const TIMEOUT_MS = process.env.SMALLCODE_RERUN_TIMEOUT_MS ?? `${20 * 60 * 1000}`;

const log = readFileSync(LOG, "utf-8");
const lines = log.split("\n");

// Problems that had >=1 trial timeout.
const timedOut = new Set<string>();
for (const l of lines) {
  const m = l.match(/^\s*(HumanEval_\S+) trial \d+: trial timeout/);
  if (m?.[1]) timedOut.add(m[1]);
}

// Map problem name -> dataset offset (0-based) via the "[N/159] NAME:" result line.
const nameToOffset = new Map<string, number>();
for (const l of lines) {
  const m = l.match(/^\s*\[(\d+)\/\d+\]\s+(HumanEval_\S+):/);
  if (m?.[1] && m?.[2]) nameToOffset.set(m[2], parseInt(m[1], 10) - 1);
}

const targets = [...timedOut]
  .map((name) => ({ name, offset: nameToOffset.get(name) }))
  .filter((t): t is { name: string; offset: number } => t.offset !== undefined)
  .sort((a, b) => a.offset - b.offset);

console.log(`[rerun] ${targets.length} timeout-affected problems, k=${K}, cap=${Number(TIMEOUT_MS) / 60000}min`);
console.log(`[rerun] targets: ${targets.map((t) => `${t.name}@${t.offset}`).join(", ")}\n`);

interface Row { name: string; np: number; k: number }
const rows: Row[] = [];

for (const t of targets) {
  // Hard per-problem wall clock = K trials × per-trial cap + 3min buffer (dataset
  // fetch + provider init). Guarantees the subprocess dies even if an inner timeout
  // fails to fire (e.g. a hung network fetch with no timeout of its own).
  const hardCapMs = Number(TIMEOUT_MS) * Number(K) + 180_000;
  const proc = Bun.spawnSync(["bun", "scripts/run-humaneval.ts"], {
    cwd: process.cwd(),
    timeout: hardCapMs,
    env: {
      ...process.env,
      SMALLCODE_HE_OFFSET: String(t.offset),
      SMALLCODE_HE_LIMIT: "1",
      SMALLCODE_HE_K: K,
      SMALLCODE_HE_TIMEOUT_MS: TIMEOUT_MS,
    },
  });
  const out = new TextDecoder().decode(proc.stdout);
  const m = out.match(/:\s+(\d+)\/(\d+)\s+(?:✓|✗|~)/);
  const np = m ? parseInt(m[1]!, 10) : 0;
  const k = m ? parseInt(m[2]!, 10) : Number(K);
  rows.push({ name: t.name, np, k });
  const sym = np === k ? "✓" : np === 0 ? "✗" : "~";
  console.log(`  ${t.name}: ${np}/${k} ${sym}`);
}

const trials = rows.reduce((s, r) => s + r.k, 0);
const passes = rows.reduce((s, r) => s + r.np, 0);
const nowClean = rows.filter((r) => r.np === r.k).length;
const stillFail = rows.filter((r) => r.np === 0);

console.log(`\n[rerun] ===== CLEAN-RERUN RESULTS =====`);
console.log(`  reran problems:     ${rows.length}`);
console.log(`  pass@1 (mean):      ${(passes / trials).toFixed(3)}  (${passes}/${trials})`);
console.log(`  now fully clean:    ${nowClean}/${rows.length}`);
console.log(`  still 0/${K} (real): ${stillFail.map((r) => r.name).join(", ") || "none"}`);
