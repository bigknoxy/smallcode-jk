#!/usr/bin/env bun
/**
 * External benchmark runner: MultiPL-E HumanEval (TypeScript translation).
 *
 * Proves smallcode generalizes beyond the in-house capability suite by running
 * the real HumanEval problems (translated to TS by nuprl/MultiPL-E) through the
 * full agent loop and grading with `bun test`.
 *
 * Honesty notes:
 *  - The agent's CONTEXT contains only the function stub, never the test file —
 *    so it must write a general solution, not pattern-match asserts.
 *  - The test file lives on disk (bun test needs it) and the early-stop oracle
 *    runs it, exactly like a real repo with a test suite.
 *
 * Usage:
 *   SMALLCODE_HE_LIMIT=20 SMALLCODE_HE_K=3 bun scripts/run-humaneval.ts
 *   SMALLCODE_HE_OFFSET=0  (start index into the 164 problems)
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import { runLoop } from "../src/agent/loop.ts";
import { createState, getStatePath } from "../src/agent/state.ts";
import type { ContextBundle } from "../src/context/types.ts";

const LIMIT = Number(process.env.SMALLCODE_HE_LIMIT ?? "20");
const OFFSET = Number(process.env.SMALLCODE_HE_OFFSET ?? "0");
const K = Number(process.env.SMALLCODE_HE_K ?? "3");
const MAX_TURNS = Number(process.env.SMALLCODE_HE_MAX_TURNS ?? "5");
const TRIAL_TIMEOUT_MS = Number(process.env.SMALLCODE_HE_TIMEOUT_MS ?? `${10 * 60 * 1000}`);
const DATASET_URL =
  "https://datasets-server.huggingface.co/rows?dataset=nuprl/MultiPL-E&config=humaneval-ts&split=test";

interface MpeProblem {
  name: string;
  prompt: string;
  tests: string;
}

/**
 * Local cache of the full dataset. Built once by scripts/cache-humaneval.ts, it
 * makes per-problem runs network-independent — a dropped connection mid-run can
 * no longer turn a solvable problem into a phantom 0/3 fetch failure.
 */
const CACHE_PATH = process.env.SMALLCODE_HE_CACHE ?? "/tmp/mpe-he-ts.json";

/** Fetch `count` problems starting at `offset` (HF API caps length at 100/call). */
export async function fetchProblems(offset: number, count: number): Promise<MpeProblem[]> {
  // Prefer the local cache: if it holds the requested slice, no network at all.
  const cacheFile = Bun.file(CACHE_PATH);
  if (await cacheFile.exists()) {
    const all = (await cacheFile.json()) as MpeProblem[];
    const slice = all.slice(offset, offset + count);
    if (slice.length === count || (slice.length > 0 && offset + count > all.length)) {
      return slice;
    }
  }

  const out: MpeProblem[] = [];
  let got = 0;
  while (got < count) {
    const len = Math.min(100, count - got);
    const url = `${DATASET_URL}&offset=${offset + got}&length=${len}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`dataset fetch failed: HTTP ${res.status}`);
    const json = (await res.json()) as { rows: Array<{ row: MpeProblem }> };
    if (json.rows.length === 0) break;
    for (const r of json.rows) out.push(r.row);
    got += json.rows.length;
  }
  return out;
}

/** Last `function <name>(` in the stub is the target to implement. */
export function entryName(prompt: string, name: string): string {
  const matches = [...prompt.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  const last = matches.at(-1);
  if (last?.[1]) return last[1];
  return name.replace(/^HumanEval_\d+_/, "");
}

/** Export the target function so the test file can import it. */
export function exportedStub(prompt: string, entry: string): string {
  if (new RegExp(`export\\s+function\\s+${entry}\\b`).test(prompt)) return prompt;
  return prompt.replace(new RegExp(`function\\s+${entry}\\b`), `export function ${entry}`);
}

/** Wrap MultiPL-E's node:assert test() into a bun:test that imports the solution. */
export function buildTestFile(tests: string, entry: string, name: string): string {
  let body = tests.replace(/function\s+test\s*\(\s*\)/, "function __mpe_test()");
  body = body.replace(/\n\s*test\s*\(\s*\)\s*;?\s*$/, "\n"); // drop trailing test();
  return [
    `import { test as __it } from "bun:test";`,
    `import { ${entry} } from "../src/solution.ts";`,
    ``,
    body.trim(),
    ``,
    `__it(${JSON.stringify(name)}, () => { __mpe_test(); });`,
    ``,
  ].join("\n");
}

export function runBunTest(dir: string): boolean {
  const proc = Bun.spawnSync(["bun", "test"], { cwd: dir, timeout: 60_000 });
  const out =
    (proc.stdout instanceof Uint8Array ? new TextDecoder().decode(proc.stdout) : "") +
    (proc.stderr instanceof Uint8Array ? new TextDecoder().decode(proc.stderr) : "");
  const failMatch = out.match(/(\d+)\s+fail/i);
  const failCount = failMatch ? parseInt(failMatch[1] ?? "0", 10) : 0;
  return proc.exitCode === 0 && failCount === 0;
}

interface ProblemResult {
  name: string;
  passes: boolean[]; // one per trial
}

async function main(): Promise<void> {
  console.log(
    `[humaneval] MultiPL-E humaneval-ts | problems ${OFFSET}..${OFFSET + LIMIT - 1} | k=${K}`,
  );

  const problems = await fetchProblems(OFFSET, LIMIT);
  console.log(`[humaneval] fetched ${problems.length} problems\n`);

  const { config, extraModels } = loadConfig();
  for (const m of extraModels) defaultRegistry.register(m);
  const profile = defaultRegistry.get(config.activeModel);
  const provider = createProvider(config.provider, defaultRegistry);
  const reasoningHandler = new ReasoningHandler(
    profile.reasoningTags ?? { open: "<think>", close: "</think>" },
  );

  const results: ProblemResult[] = [];

  for (let p = 0; p < problems.length; p++) {
    const prob = problems[p]!;
    const entry = entryName(prob.prompt, prob.name);
    const stub = exportedStub(prob.prompt, entry);
    const testFile = buildTestFile(prob.tests, entry, prob.name);
    const passes: boolean[] = [];

    for (let trial = 0; trial < K; trial++) {
      const dir = await mkdtemp(join(tmpdir(), "smallcode-he-"));
      let passed = false;
      try {
        await mkdir(join(dir, "src"), { recursive: true });
        await mkdir(join(dir, "tests"), { recursive: true });
        await writeFile(join(dir, "src", "solution.ts"), stub, "utf-8");
        await writeFile(join(dir, "tests", "solution.test.ts"), testFile, "utf-8");
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "he", module: "src/solution.ts", type: "module" }, null, 2),
          "utf-8",
        );

        const agentConfig = {
          repoRoot: dir,
          modelId: profile.id,
          maxTurns: MAX_TURNS,
          bestOfN: 1,
          statePath: join(dir, ".smallcode", "state.json"),
          allowedCommands: config.sandbox.allowedCommands,
          requireApproval: false,
        };
        const task =
          `Implement the body of the function in src/solution.ts so it matches its documented ` +
          `behavior (see the comment above it). Output the complete file.`;
        const state = createState(agentConfig, task);
        const statePath = getStatePath(agentConfig);

        // Context = ONLY the stub. The test file is never shown to the model.
        const getContext = async (query: string): Promise<ContextBundle> => ({
          chunks: [
            {
              filePath: "src/solution.ts",
              startLine: 1,
              endLine: stub.split("\n").length,
              content: stub,
              estimatedTokens: Math.ceil(stub.length / 4),
            },
          ],
          totalTokens: Math.ceil(stub.length / 4),
          tokenBudget: 8000,
          truncated: false,
          query,
        });

        const timeoutErr = new Error("trial timeout");
        await Promise.race([
          runLoop(state, statePath, { provider, profile, reasoningHandler, config: agentConfig }, getContext),
          new Promise<never>((_, rej) => setTimeout(() => rej(timeoutErr), TRIAL_TIMEOUT_MS)),
        ]);

        passed = runBunTest(dir);
      } catch (err) {
        console.error(`    ${prob.name} trial ${trial}: ${err instanceof Error ? err.message : err}`);
        passed = false;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      passes.push(passed);
    }

    results.push({ name: prob.name, passes });
    const np = passes.filter(Boolean).length;
    console.log(
      `  [${p + 1}/${problems.length}] ${prob.name}: ${np}/${K} ${np === K ? "✓" : np === 0 ? "✗" : "~"}`,
    );
  }

  // Aggregate
  const nProblems = results.length;
  const totalTrials = nProblems * K;
  const totalPasses = results.reduce((s, r) => s + r.passes.filter(Boolean).length, 0);
  const allKPass = results.filter((r) => r.passes.every(Boolean)).length;
  const anyPass = results.filter((r) => r.passes.some(Boolean)).length;

  console.log(`\n[humaneval] ===== RESULTS =====`);
  console.log(`  problems:        ${nProblems}`);
  console.log(`  pass@1 (mean):   ${(totalPasses / totalTrials).toFixed(3)}  (${totalPasses}/${totalTrials} trials)`);
  console.log(`  pass^${K} (all-k):   ${(allKPass / nProblems).toFixed(3)}  (${allKPass}/${nProblems} problems)`);
  console.log(`  pass@${K} (any-k):   ${(anyPass / nProblems).toFixed(3)}  (${anyPass}/${nProblems} problems)`);
}

if (import.meta.main)
main().catch((err: unknown) => {
  console.error("[humaneval] ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
