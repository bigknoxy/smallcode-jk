#!/usr/bin/env bun
/**
 * Fetch the full MultiPL-E humaneval-ts dataset ONCE and cache it to disk, so
 * subsequent benchmark/rerun invocations are network-independent. Run this while
 * the network is healthy; run-humaneval.ts then reads the cache (see fetchProblems).
 *
 * Usage: bun scripts/cache-humaneval.ts
 *   SMALLCODE_HE_CACHE=/tmp/mpe-he-ts.json (output path)
 */
const CACHE_PATH = process.env.SMALLCODE_HE_CACHE ?? "/tmp/mpe-he-ts.json";
const DATASET_URL =
  "https://datasets-server.huggingface.co/rows?dataset=nuprl/MultiPL-E&config=humaneval-ts&split=test";

interface MpeProblem {
  name: string;
  prompt: string;
  tests: string;
}

const all: MpeProblem[] = [];
let offset = 0;
while (true) {
  const url = `${DATASET_URL}&offset=${offset}&length=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dataset fetch failed: HTTP ${res.status} at offset ${offset}`);
  const json = (await res.json()) as { rows: Array<{ row: MpeProblem }> };
  if (json.rows.length === 0) break;
  for (const r of json.rows) all.push(r.row);
  offset += json.rows.length;
  console.log(`[cache] fetched ${all.length} problems...`);
  if (json.rows.length < 100) break;
}

await Bun.write(CACHE_PATH, JSON.stringify(all));
console.log(`[cache] wrote ${all.length} problems -> ${CACHE_PATH}`);
