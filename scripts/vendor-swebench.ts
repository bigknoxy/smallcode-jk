#!/usr/bin/env bun
// R5b: SWE-bench-Lite INGESTION harness.
//
// Fetches SWE-bench-Lite instances (princeton-nlp/SWE-bench_Lite) from the
// HuggingFace datasets-server and converts each into a self-describing smallcode
// SWE-bench task descriptor under evals/suites/swebench-lite/. The descriptor
// carries everything the runner needs: the issue text (the agent's task), the
// repo + base_commit to check out, the test_patch that adds the FAIL_TO_PASS
// tests, and the FAIL_TO_PASS / PASS_TO_PASS test ids that form the oracle.
//
// HONEST SCOPE: this script INGESTS the benchmark. EXECUTION at scale is NOT done
// here — SWE-bench-Lite's repos (astropy, scikit-learn, sympy, django, matplotlib,
// …) are heavy C-extension packages with per-instance pinned environments, which
// is exactly why the official harness ships a Docker image per instance. Running
// these offline on a laptop is impractical, and a 3B scores ~0 on real repo issues
// regardless. We therefore do NOT fabricate a pass-rate; we produce runnable task
// descriptors + the pytest grader wiring, and scripts/run-swebench.ts executes
// them only against a PREPARED environment (see its header). The value here is the
// reusable conversion, not a benchmark number.
//
//   SWEBENCH_LIMIT=20 bun scripts/vendor-swebench.ts
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "evals/suites/swebench-lite");
const LIMIT = Number(process.env.SWEBENCH_LIMIT ?? "20");
const HF = "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Lite&config=default&split=test";

interface Instance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  test_patch: string;
  patch: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
}

async function fetchRows(offset: number, length: number): Promise<Instance[]> {
  const r = await fetch(`${HF}&offset=${offset}&length=${length}`);
  if (!r.ok) throw new Error(`HF datasets-server ${r.status}`);
  const j = (await r.json()) as { rows: { row: Instance }[] };
  return j.rows.map((x) => x.row);
}

function asList(v: string | string[]): string[] {
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v ? [v] : [];
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await writeFile(
  join(OUT, "suite.json"),
  `${JSON.stringify({ id: "swebench-lite-v1", kind: "capability", description: "SWE-bench-Lite real GitHub-issue tasks (princeton-nlp/SWE-bench_Lite). INGESTION ONLY — execution needs a prepared per-instance env / the official Docker harness; see scripts/run-swebench.ts. No fabricated pass-rate.", defaultTrials: 1 }, null, 2)}\n`,
);

let kept = 0;
const byRepo: Record<string, number> = {};
for (let offset = 0; kept < LIMIT && offset < LIMIT * 3; offset += 50) {
  const rows = await fetchRows(offset, Math.min(50, LIMIT * 3 - offset));
  for (const inst of rows) {
    if (kept >= LIMIT) break;
    const f2p = asList(inst.FAIL_TO_PASS);
    const p2p = asList(inst.PASS_TO_PASS);
    if (f2p.length === 0) continue;
    byRepo[inst.repo] = (byRepo[inst.repo] ?? 0) + 1;
    await writeFile(
      join(OUT, `${inst.instance_id}.json`),
      `${JSON.stringify(
        {
          id: inst.instance_id,
          desc: inst.problem_statement,
          // SWE-bench setup is NOT a static fixture — the runner clones the repo.
          setup: {
            swebench: {
              repo: inst.repo,
              base_commit: inst.base_commit,
              test_patch: inst.test_patch,
            },
          },
          graders: [
            {
              type: "deterministic_tests",
              required: [],
              command: `python3 -m pytest -q ${f2p.map((t) => `"${t}"`).join(" ")}`,
            },
          ],
          tracked_metrics: ["n_turns", "n_toolcalls", "n_total_tokens", "pass_at_1", "editFormatOk"],
          tags: ["swebench-lite", inst.repo],
          fail_to_pass: f2p,
          pass_to_pass: p2p,
          gold_patch: inst.patch,
        },
        null,
        2,
      )}\n`,
    );
    kept++;
  }
}

console.log(`[vendor-swebench] wrote ${kept} instance descriptors → evals/suites/swebench-lite`);
console.log(`[vendor-swebench] repos: ${Object.entries(byRepo).map(([r, n]) => `${r}=${n}`).join(", ")}`);
console.log("[vendor-swebench] EXECUTION requires a prepared env — see scripts/run-swebench.ts (no run done here).");
