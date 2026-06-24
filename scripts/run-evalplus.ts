#!/usr/bin/env bun
/**
 * External benchmark runner: EvalPlus-style (HumanEval+ / MBPP+).
 *
 * EvalPlus augments the original HumanEval/MBPP prompts with a much larger set
 * of automatically-generated test cases that catch edge-case over-fitting. This
 * runner uses the same MultiPL-E dataset as run-humaneval.ts but simulates the
 * "plus" philosophy: each problem's test body is split into a *base* section
 * (first N asserts) and an *extra* section (the rest). Reported separately so
 * you can see if a solution passes the easy cases but fails the harder ones.
 *
 * Dataset: nuprl/MultiPL-E humaneval-ts (same as run-humaneval.ts).
 * Cache: /tmp/mpe-he-ts.json (written by scripts/cache-humaneval.ts).
 *
 * Usage:
 *   bun scripts/run-evalplus.ts
 *   SMALLCODE_EP_LIMIT=20 SMALLCODE_EP_K=3 bun scripts/run-evalplus.ts
 *   bun scripts/run-evalplus.ts --dry-run      # mock mode (no Ollama)
 *
 * Env vars:
 *   SMALLCODE_EP_LIMIT       number of problems (default 20)
 *   SMALLCODE_EP_OFFSET      start index (default 0)
 *   SMALLCODE_EP_K           trials per problem (default 3)
 *   SMALLCODE_EP_MAX_TURNS   agent turns per trial (default 5)
 *   SMALLCODE_EP_TIMEOUT_MS  per-trial wall-clock cap (default 10 min)
 *   SMALLCODE_EP_CACHE       path to local dataset cache (default /tmp/mpe-he-ts.json)
 *   SMALLCODE_EP_BASE_SPLIT  fraction of asserts used as "base" (default 0.5)
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIMIT = Number(process.env.SMALLCODE_EP_LIMIT ?? "20");
const OFFSET = Number(process.env.SMALLCODE_EP_OFFSET ?? "0");
const K = Number(process.env.SMALLCODE_EP_K ?? "3");
const MAX_TURNS = Number(process.env.SMALLCODE_EP_MAX_TURNS ?? "5");
const TRIAL_TIMEOUT_MS = Number(process.env.SMALLCODE_EP_TIMEOUT_MS ?? `${10 * 60 * 1000}`);
const CACHE_PATH = process.env.SMALLCODE_EP_CACHE ?? "/tmp/mpe-he-ts.json";
const BASE_SPLIT = Number(process.env.SMALLCODE_EP_BASE_SPLIT ?? "0.5");
const DATASET_URL =
  "https://datasets-server.huggingface.co/rows?dataset=nuprl/MultiPL-E&config=humaneval-ts&split=test";

export interface EvalPlusProblem {
  name: string;
  prompt: string;
  tests: string;
}

/**
 * Fetch problems from local cache (prefers it) or Hugging Face API.
 * Identical caching strategy to run-humaneval.ts `fetchProblems`.
 */
export async function fetchProblems(offset: number, count: number): Promise<EvalPlusProblem[]> {
  const cacheFile = Bun.file(CACHE_PATH);
  if (await cacheFile.exists()) {
    const all = (await cacheFile.json()) as EvalPlusProblem[];
    const slice = all.slice(offset, offset + count);
    if (slice.length === count || (slice.length > 0 && offset + count > all.length)) {
      return slice;
    }
  }

  const out: EvalPlusProblem[] = [];
  let got = 0;
  while (got < count) {
    const len = Math.min(100, count - got);
    const url = `${DATASET_URL}&offset=${offset + got}&length=${len}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`dataset fetch failed: HTTP ${res.status}`);
    const json = (await res.json()) as { rows: Array<{ row: EvalPlusProblem }> };
    if (json.rows.length === 0) break;
    for (const r of json.rows) out.push(r.row);
    got += json.rows.length;
  }
  return out;
}

/** Resolve the exported function name from the stub (same logic as run-humaneval.ts). */
export function entryName(prompt: string, name: string): string {
  const matches = [...prompt.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  const last = matches.at(-1);
  if (last?.[1]) return last[1];
  return name.replace(/^HumanEval_\d+_/, "");
}

/** Add `export` to the target function so the test file can import it. */
export function exportedStub(prompt: string, entry: string): string {
  if (new RegExp(`export\\s+function\\s+${entry}\\b`).test(prompt)) return prompt;
  return prompt.replace(new RegExp(`function\\s+${entry}\\b`), `export function ${entry}`);
}

/**
 * Split the raw test body into base (first `splitFraction`) and extra (remainder) asserts.
 * Lines that are not standalone `assert(...)` statements are kept in both halves as
 * preamble/helpers.
 *
 * Returns `{ base, extra }` where `extra` may be empty if splitFraction >= 1.
 */
export function splitTests(tests: string, splitFraction: number): { base: string[]; extra: string[] } {
  const lines = tests.split("\n");
  const assertLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*assert\s*\(/.test(lines[i]!)) assertLines.push(i);
  }

  const cutIdx = Math.max(1, Math.ceil(assertLines.length * splitFraction));
  const cutLine = assertLines[cutIdx - 1] ?? lines.length - 1;

  const base = lines.slice(0, cutLine + 1);
  const extra = lines.slice(cutLine + 1);
  return { base, extra };
}

/**
 * Build a `bun:test` test file for one segment (base or extra) of the tests.
 * Returns null when the segment is empty (no assert lines).
 */
export function buildTestFile(
  testLines: string[],
  entry: string,
  name: string,
  label: "base" | "extra",
): string | null {
  const body = testLines.join("\n").trim();
  if (!body || !/assert\s*\(/.test(body)) return null;

  let sanitised = body.replace(/function\s+test\s*\(\s*\)/, "function __ep_test()");
  sanitised = sanitised.replace(/\n\s*test\s*\(\s*\)\s*;?\s*$/, "\n");

  return [
    `import { test as __it } from "bun:test";`,
    `import { ${entry} } from "../src/solution.ts";`,
    ``,
    sanitised,
    ``,
    `__it(${JSON.stringify(`${name}:${label}`)}, () => { __ep_test(); });`,
    ``,
  ].join("\n");
}

/** Run `bun test` in `dir`, return pass/fail. */
export function runBunTest(dir: string): boolean {
  const proc = Bun.spawnSync(["bun", "test"], { cwd: dir, timeout: 60_000 });
  const out =
    (proc.stdout instanceof Uint8Array ? new TextDecoder().decode(proc.stdout) : "") +
    (proc.stderr instanceof Uint8Array ? new TextDecoder().decode(proc.stderr) : "");
  const failMatch = out.match(/(\d+)\s+fail/i);
  const failCount = failMatch ? parseInt(failMatch[1] ?? "0", 10) : 0;
  return proc.exitCode === 0 && failCount === 0;
}

export interface EvalPlusResult {
  name: string;
  /** pass[trial] = { base, extra } */
  passes: Array<{ base: boolean; extra: boolean }>;
}

/** Aggregate pass@1 and pass@k from a result set. */
export function aggregateResults(
  results: EvalPlusResult[],
  k: number,
): {
  pass1Base: number;
  pass1Extra: number;
  passKBase: number;
  passKExtra: number;
  allKPassBase: number;
  allKPassExtra: number;
  anyKPassBase: number;
  anyKPassExtra: number;
} {
  const n = results.length;
  if (n === 0)
    return {
      pass1Base: 0,
      pass1Extra: 0,
      passKBase: 0,
      passKExtra: 0,
      allKPassBase: 0,
      allKPassExtra: 0,
      anyKPassBase: 0,
      anyKPassExtra: 0,
    };

  const totalTrials = n * k;
  const totalBasePass = results.reduce((s, r) => s + r.passes.filter((p) => p.base).length, 0);
  const totalExtraPass = results.reduce(
    (s, r) => s + r.passes.filter((p) => p.base && p.extra).length,
    0,
  );

  const allKBase = results.filter((r) => r.passes.every((p) => p.base)).length;
  const allKExtra = results.filter((r) => r.passes.every((p) => p.base && p.extra)).length;
  const anyKBase = results.filter((r) => r.passes.some((p) => p.base)).length;
  const anyKExtra = results.filter((r) => r.passes.some((p) => p.base && p.extra)).length;

  return {
    pass1Base: totalBasePass / totalTrials,
    pass1Extra: totalExtraPass / totalTrials,
    passKBase: allKBase / n,
    passKExtra: allKExtra / n,
    allKPassBase: allKBase,
    allKPassExtra: allKExtra,
    anyKPassBase: anyKBase,
    anyKPassExtra: anyKExtra,
  };
}

/**
 * Solution source injectable for testing/dry-run.
 * Receives the function stub and returns the complete file content.
 */
export type SolutionSource = (stub: string, entry: string) => Promise<string>;

/** Default solution source: pass-through stub unchanged (skeleton, will fail tests). */
export const stubSolutionSource: SolutionSource = async (stub) => stub;

async function main(): Promise<void> {
  const dryRun =
    process.argv.includes("--dry-run") || process.env.SMALLCODE_EP_DRY_RUN === "1";

  console.log(
    `[evalplus] HumanEval+ style | problems ${OFFSET}..${OFFSET + LIMIT - 1} | k=${K} | base_split=${BASE_SPLIT}${dryRun ? " | DRY-RUN" : ""}`,
  );

  const problems = await fetchProblems(OFFSET, LIMIT);
  console.log(`[evalplus] fetched ${problems.length} problems\n`);

  let solutionSource: SolutionSource;
  if (dryRun) {
    solutionSource = stubSolutionSource;
  } else {
    const { loadConfig } = await import("../src/config/loader.ts");
    const { defaultRegistry } = await import("../src/models/registry.ts");
    const { createProvider } = await import("../src/provider/factory.ts");
    const { ReasoningHandler } = await import("../src/reasoning/handler.ts");
    const { runLoop } = await import("../src/agent/loop.ts");
    const { createState, getStatePath } = await import("../src/agent/state.ts");

    const { config, extraModels } = loadConfig();
    for (const m of extraModels) defaultRegistry.register(m);
    const profile = defaultRegistry.get(config.activeModel);
    const provider = createProvider(config.provider, defaultRegistry);
    const reasoningHandler = new ReasoningHandler(
      profile.reasoningTags ?? { open: "<think>", close: "</think>" },
    );

    solutionSource = async (stub: string, entry: string): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), "smallcode-ep-solve-"));
      try {
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "solution.ts"), stub, "utf-8");
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "ep", module: "src/solution.ts", type: "module" }, null, 2),
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

        const getContext = async (query: string) => ({
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

        const solFile = Bun.file(join(dir, "src", "solution.ts"));
        return await solFile.text();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };
  }

  const results: EvalPlusResult[] = [];

  for (let p = 0; p < problems.length; p++) {
    const prob = problems[p]!;
    const entry = entryName(prob.prompt, prob.name);
    const stub = exportedStub(prob.prompt, entry);

    const { base: baseLines, extra: extraLines } = splitTests(prob.tests, BASE_SPLIT);
    const baseFile = buildTestFile(baseLines, entry, prob.name, "base");
    const extraFile = buildTestFile(extraLines, entry, prob.name, "extra");

    const passes: Array<{ base: boolean; extra: boolean }> = [];

    for (let trial = 0; trial < K; trial++) {
      const dir = await mkdtemp(join(tmpdir(), "smallcode-ep-"));
      let basePass = false;
      let extraPass = false;
      try {
        await mkdir(join(dir, "src"), { recursive: true });
        await mkdir(join(dir, "tests"), { recursive: true });
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "ep", module: "src/solution.ts", type: "module" }, null, 2),
          "utf-8",
        );

        let solution: string;
        try {
          solution = await solutionSource(stub, entry);
        } catch (err) {
          console.error(
            `    ${prob.name} trial ${trial} (solve): ${err instanceof Error ? err.message : err}`,
          );
          passes.push({ base: false, extra: false });
          continue;
        }

        await writeFile(join(dir, "src", "solution.ts"), solution, "utf-8");

        // Grade base tests
        if (baseFile) {
          await writeFile(join(dir, "tests", "base.test.ts"), baseFile, "utf-8");
          basePass = runBunTest(dir);
          await rm(join(dir, "tests", "base.test.ts"), { force: true });
        }

        // Grade extra tests (only if base passed — mirrors EvalPlus paper logic)
        if (basePass && extraFile) {
          await writeFile(join(dir, "tests", "extra.test.ts"), extraFile, "utf-8");
          extraPass = runBunTest(dir);
          await rm(join(dir, "tests", "extra.test.ts"), { force: true });
        }
      } catch (err) {
        console.error(`    ${prob.name} trial ${trial}: ${err instanceof Error ? err.message : err}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      passes.push({ base: basePass, extra: extraPass });
    }

    results.push({ name: prob.name, passes });
    const nb = passes.filter((p) => p.base).length;
    const ne = passes.filter((p) => p.base && p.extra).length;
    const sym = ne === K ? "✓" : ne === 0 && nb === 0 ? "✗" : "~";
    console.log(
      `  [${p + 1}/${problems.length}] ${prob.name}: base ${nb}/${K} extra ${ne}/${K} ${sym}`,
    );
  }

  // Aggregate
  const agg = aggregateResults(results, K);
  const n = results.length;
  const totalTrials = n * K;
  const baseTrials = results.reduce((s, r) => s + r.passes.filter((p) => p.base).length, 0);
  const extraTrials = results.reduce(
    (s, r) => s + r.passes.filter((p) => p.base && p.extra).length,
    0,
  );

  console.log(`\n[evalplus] ===== RESULTS =====`);
  console.log(`  problems:              ${n}`);
  console.log(
    `  pass@1 base (mean):    ${agg.pass1Base.toFixed(3)}  (${baseTrials}/${totalTrials} trials)`,
  );
  console.log(
    `  pass@1 extra (mean):   ${agg.pass1Extra.toFixed(3)}  (${extraTrials}/${totalTrials} trials)`,
  );
  console.log(
    `  pass^${K} base (all-k):  ${agg.passKBase.toFixed(3)}  (${agg.allKPassBase}/${n} problems)`,
  );
  console.log(
    `  pass^${K} extra (all-k): ${agg.passKExtra.toFixed(3)}  (${agg.allKPassExtra}/${n} problems)`,
  );
  console.log(
    `  pass@${K} base (any-k):  ${agg.anyKPassBase / n <= 0 ? "0.000" : (agg.anyKPassBase / n).toFixed(3)}  (${agg.anyKPassBase}/${n} problems)`,
  );
  console.log(
    `  pass@${K} extra (any-k): ${agg.anyKPassExtra / n <= 0 ? "0.000" : (agg.anyKPassExtra / n).toFixed(3)}  (${agg.anyKPassExtra}/${n} problems)`,
  );
}

if (import.meta.main)
  main().catch((err: unknown) => {
    console.error("[evalplus] ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
