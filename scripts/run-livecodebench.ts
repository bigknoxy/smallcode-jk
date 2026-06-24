#!/usr/bin/env bun
/**
 * External benchmark runner: LiveCodeBench-style (contamination-free, time-windowed).
 *
 * LiveCodeBench collects competitive-programming problems from Codeforces, LeetCode,
 * and AtCoder released AFTER a cutoff date, ensuring the model cannot have memorised
 * solutions from training data. We simulate this with a synthetic local dataset:
 *   - Format: array of LcbProblem in CACHE_PATH (JSON)
 *   - Each problem has a prompt (function stub), tests, and a `releasedAt` timestamp
 *   - `--after` / SMALLCODE_LCB_AFTER filters to problems released after that ISO date
 *
 * Because we do NOT currently have a live LCB API:
 *   - A real fetch URL is documented (hardcoded) but the cache is preferred.
 *   - In --dry-run mode (or when no live models are available) an injectable
 *     SolutionSource can be provided (used by tests).
 *
 * Dataset format expected in CACHE_PATH:
 *   Array<{ name: string; prompt: string; tests: string; releasedAt: string; difficulty?: string }>
 *
 * Usage:
 *   bun scripts/run-livecodebench.ts
 *   SMALLCODE_LCB_LIMIT=20 SMALLCODE_LCB_K=3 bun scripts/run-livecodebench.ts
 *   bun scripts/run-livecodebench.ts --dry-run
 *   SMALLCODE_LCB_AFTER=2024-09-01 bun scripts/run-livecodebench.ts
 *
 * Env vars:
 *   SMALLCODE_LCB_LIMIT        problems to run (default 20)
 *   SMALLCODE_LCB_OFFSET       start index into filtered set (default 0)
 *   SMALLCODE_LCB_K            trials per problem (default 3)
 *   SMALLCODE_LCB_MAX_TURNS    agent turns per trial (default 5)
 *   SMALLCODE_LCB_TIMEOUT_MS   per-trial wall-clock cap (default 10 min)
 *   SMALLCODE_LCB_CACHE        local dataset cache path (default /tmp/lcb-ts.json)
 *   SMALLCODE_LCB_AFTER        ISO date — only problems released after this (optional)
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIMIT = Number(process.env.SMALLCODE_LCB_LIMIT ?? "20");
const OFFSET = Number(process.env.SMALLCODE_LCB_OFFSET ?? "0");
const K = Number(process.env.SMALLCODE_LCB_K ?? "3");
const MAX_TURNS = Number(process.env.SMALLCODE_LCB_MAX_TURNS ?? "5");
const TRIAL_TIMEOUT_MS = Number(process.env.SMALLCODE_LCB_TIMEOUT_MS ?? `${10 * 60 * 1000}`);
const CACHE_PATH = process.env.SMALLCODE_LCB_CACHE ?? "/tmp/lcb-ts.json";
const AFTER_DATE = process.env.SMALLCODE_LCB_AFTER ?? "";

/**
 * NOTE (dataset URL): LiveCodeBench does not yet publish a Hugging Face rows API for TS problems.
 * When it does, replace this URL with the real endpoint and update fetchProblems.
 * For now the runner is fully functional via the local cache (CACHE_PATH).
 */
export const LCB_DATASET_URL = "https://datasets-server.huggingface.co/rows?dataset=livecodebench/code_generation&config=default&split=test";

export interface LcbProblem {
  name: string;
  prompt: string;
  tests: string;
  /** ISO 8601 date string, e.g. "2024-10-15" */
  releasedAt: string;
  difficulty?: "easy" | "medium" | "hard";
}

/**
 * Load problems from local cache, filtered by after-date and sliced.
 * Falls back to a fetch from LCB_DATASET_URL if cache is absent (placeholder).
 */
export async function fetchProblems(
  offset: number,
  count: number,
  afterDate?: string,
): Promise<LcbProblem[]> {
  let all: LcbProblem[] = [];

  const cacheFile = Bun.file(CACHE_PATH);
  if (await cacheFile.exists()) {
    all = (await cacheFile.json()) as LcbProblem[];
  } else {
    // Placeholder: real fetch when API is available.
    // At this point we return empty and let the caller decide.
    console.warn(`[livecodebench] cache not found at ${CACHE_PATH}. Run scripts/cache-livecodebench.ts first.`);
    return [];
  }

  // Filter by contamination cutoff.
  if (afterDate) {
    const cutoff = new Date(afterDate).getTime();
    all = all.filter((p) => {
      const t = new Date(p.releasedAt).getTime();
      return !isNaN(t) && t > cutoff;
    });
  }

  return all.slice(offset, offset + count);
}

/** Resolve the exported entry function name from the stub. */
export function entryName(prompt: string, name: string): string {
  const matches = [...prompt.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  const last = matches.at(-1);
  if (last?.[1]) return last[1];
  return name.replace(/^lcb_\d+_/, "").replace(/[^A-Za-z0-9_$]/g, "_");
}

/** Add `export` to the target function so test files can import it. */
export function exportedStub(prompt: string, entry: string): string {
  if (new RegExp(`export\\s+function\\s+${entry}\\b`).test(prompt)) return prompt;
  return prompt.replace(new RegExp(`function\\s+${entry}\\b`), `export function ${entry}`);
}

/**
 * Build a `bun:test` test file from the raw test body.
 * Wraps the test body as a named bun:test case.
 */
export function buildTestFile(tests: string, entry: string, name: string): string {
  let body = tests.replace(/function\s+test\s*\(\s*\)/, "function __lcb_test()");
  body = body.replace(/\n\s*test\s*\(\s*\)\s*;?\s*$/, "\n");
  return [
    `import { test as __it } from "bun:test";`,
    `import { ${entry} } from "../src/solution.ts";`,
    ``,
    body.trim(),
    ``,
    `__it(${JSON.stringify(name)}, () => { __lcb_test(); });`,
    ``,
  ].join("\n");
}

/** Run `bun test` in `dir`; return pass/fail. */
export function runBunTest(dir: string): boolean {
  const proc = Bun.spawnSync(["bun", "test"], { cwd: dir, timeout: 60_000 });
  const out =
    (proc.stdout instanceof Uint8Array ? new TextDecoder().decode(proc.stdout) : "") +
    (proc.stderr instanceof Uint8Array ? new TextDecoder().decode(proc.stderr) : "");
  const failMatch = out.match(/(\d+)\s+fail/i);
  const failCount = failMatch ? parseInt(failMatch[1] ?? "0", 10) : 0;
  return proc.exitCode === 0 && failCount === 0;
}

export interface LcbResult {
  name: string;
  difficulty: string;
  passes: boolean[];
}

/** Compute pass@1 and pass@k stats. */
export function aggregateResults(
  results: LcbResult[],
  k: number,
): {
  pass1: number;
  passKAll: number;
  passKAny: number;
  byDifficulty: Record<string, { pass1: number; n: number }>;
} {
  const n = results.length;
  if (n === 0)
    return { pass1: 0, passKAll: 0, passKAny: 0, byDifficulty: {} };

  const totalTrials = n * k;
  const totalPass = results.reduce((s, r) => s + r.passes.filter(Boolean).length, 0);
  const allK = results.filter((r) => r.passes.every(Boolean)).length;
  const anyK = results.filter((r) => r.passes.some(Boolean)).length;

  const byDiff: Record<string, { pass: number; trials: number }> = {};
  for (const r of results) {
    const d = r.difficulty || "unknown";
    if (!byDiff[d]) byDiff[d] = { pass: 0, trials: 0 };
    byDiff[d]!.pass += r.passes.filter(Boolean).length;
    byDiff[d]!.trials += k;
  }

  const byDifficulty: Record<string, { pass1: number; n: number }> = {};
  for (const [d, v] of Object.entries(byDiff)) {
    byDifficulty[d] = {
      pass1: v.trials > 0 ? v.pass / v.trials : 0,
      n: v.trials / k,
    };
  }

  return {
    pass1: totalPass / totalTrials,
    passKAll: allK / n,
    passKAny: anyK / n,
    byDifficulty,
  };
}

/**
 * Injectable solution source for testing/dry-run.
 * Receives stub + entry name; returns complete solution file content.
 */
export type SolutionSource = (stub: string, entry: string) => Promise<string>;

/** Default dry-run source: returns stub unchanged (skeleton, will fail tests). */
export const stubSolutionSource: SolutionSource = async (stub) => stub;

async function main(): Promise<void> {
  const dryRun =
    process.argv.includes("--dry-run") || process.env.SMALLCODE_LCB_DRY_RUN === "1";

  const afterLabel = AFTER_DATE ? ` | after=${AFTER_DATE}` : "";
  console.log(
    `[livecodebench] LiveCodeBench-style | problems ${OFFSET}..${OFFSET + LIMIT - 1} | k=${K}${afterLabel}${dryRun ? " | DRY-RUN" : ""}`,
  );

  const problems = await fetchProblems(OFFSET, LIMIT, AFTER_DATE || undefined);
  if (problems.length === 0) {
    console.log("[livecodebench] no problems found — check cache and --after filter.");
    return;
  }
  console.log(`[livecodebench] fetched ${problems.length} problems\n`);

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

    solutionSource = async (stub: string): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), "smallcode-lcb-solve-"));
      try {
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "solution.ts"), stub, "utf-8");
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "lcb", module: "src/solution.ts", type: "module" }, null, 2),
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

  const results: LcbResult[] = [];

  for (let p = 0; p < problems.length; p++) {
    const prob = problems[p]!;
    const entry = entryName(prob.prompt, prob.name);
    const stub = exportedStub(prob.prompt, entry);
    const testFile = buildTestFile(prob.tests, entry, prob.name);
    const passes: boolean[] = [];

    for (let trial = 0; trial < K; trial++) {
      const dir = await mkdtemp(join(tmpdir(), "smallcode-lcb-"));
      let passed = false;
      try {
        await mkdir(join(dir, "src"), { recursive: true });
        await mkdir(join(dir, "tests"), { recursive: true });
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "lcb", module: "src/solution.ts", type: "module" }, null, 2),
          "utf-8",
        );

        let solution: string;
        try {
          solution = await solutionSource(stub, entry);
        } catch (err) {
          console.error(
            `    ${prob.name} trial ${trial} (solve): ${err instanceof Error ? err.message : err}`,
          );
          passes.push(false);
          continue;
        }

        await writeFile(join(dir, "src", "solution.ts"), solution, "utf-8");
        await writeFile(join(dir, "tests", "solution.test.ts"), testFile, "utf-8");
        passed = runBunTest(dir);
      } catch (err) {
        console.error(`    ${prob.name} trial ${trial}: ${err instanceof Error ? err.message : err}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      passes.push(passed);
    }

    results.push({ name: prob.name, difficulty: prob.difficulty ?? "unknown", passes });
    const np = passes.filter(Boolean).length;
    const sym = np === K ? "✓" : np === 0 ? "✗" : "~";
    console.log(
      `  [${p + 1}/${problems.length}] ${prob.name} [${prob.difficulty ?? "?"}]: ${np}/${K} ${sym}`,
    );
  }

  const agg = aggregateResults(results, K);
  const n = results.length;
  const totalTrials = n * K;
  const totalPass = results.reduce((s, r) => s + r.passes.filter(Boolean).length, 0);
  const allKPass = results.filter((r) => r.passes.every(Boolean)).length;
  const anyKPass = results.filter((r) => r.passes.some(Boolean)).length;

  console.log(`\n[livecodebench] ===== RESULTS =====`);
  console.log(`  problems:          ${n}`);
  console.log(
    `  pass@1 (mean):     ${agg.pass1.toFixed(3)}  (${totalPass}/${totalTrials} trials)`,
  );
  console.log(
    `  pass^${K} (all-k):   ${agg.passKAll.toFixed(3)}  (${allKPass}/${n} problems)`,
  );
  console.log(
    `  pass@${K} (any-k):   ${agg.passKAny.toFixed(3)}  (${anyKPass}/${n} problems)`,
  );
  if (Object.keys(agg.byDifficulty).length > 1) {
    console.log(`\n  by difficulty:`);
    for (const [d, v] of Object.entries(agg.byDifficulty)) {
      console.log(`    ${d.padEnd(8)} pass@1=${v.pass1.toFixed(3)}  (n=${v.n})`);
    }
  }
}

if (import.meta.main)
  main().catch((err: unknown) => {
    console.error("[livecodebench] ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
