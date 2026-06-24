#!/usr/bin/env bun
/**
 * Multi-model bake-off: runs a benchmark across several model IDs and emits a
 * side-by-side comparison table (model × pass@1 / pass@k).
 *
 * Model IDs are validated through ModelRegistry (src/models/registry.ts) but
 * NEVER invoked directly — all solving goes through an injectable RunnerFn.
 * This means tests can inject a deterministic fake runner without touching Ollama.
 *
 * Usage:
 *   bun scripts/run-bakeoff.ts vibethinker-3b qwen2.5-coder-7b
 *   SMALLCODE_BO_K=3 bun scripts/run-bakeoff.ts vibethinker-3b qwen2.5-coder-7b
 *   bun scripts/run-bakeoff.ts --dry-run vibethinker-3b  # all-fail stub runner
 *
 * Env vars:
 *   SMALLCODE_BO_K              trials per problem per model (default 3)
 *   SMALLCODE_BO_LIMIT          problems to run (default 20)
 *   SMALLCODE_BO_OFFSET         start index (default 0)
 *   SMALLCODE_BO_TIMEOUT_MS     per-trial wall-clock cap (default 10 min)
 *   SMALLCODE_BO_CACHE          local dataset cache (default /tmp/mpe-he-ts.json)
 *   SMALLCODE_BO_MAX_TURNS      agent turns per trial (default 5)
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRegistry, ModelRegistry } from "../src/models/registry.ts";

const K = Number(process.env.SMALLCODE_BO_K ?? "3");
const LIMIT = Number(process.env.SMALLCODE_BO_LIMIT ?? "20");
const OFFSET = Number(process.env.SMALLCODE_BO_OFFSET ?? "0");
const TRIAL_TIMEOUT_MS = Number(process.env.SMALLCODE_BO_TIMEOUT_MS ?? `${10 * 60 * 1000}`);
const CACHE_PATH = process.env.SMALLCODE_BO_CACHE ?? "/tmp/mpe-he-ts.json";
const MAX_TURNS = Number(process.env.SMALLCODE_BO_MAX_TURNS ?? "5");
const DATASET_URL =
  "https://datasets-server.huggingface.co/rows?dataset=nuprl/MultiPL-E&config=humaneval-ts&split=test";

export interface BakeoffProblem {
  name: string;
  prompt: string;
  tests: string;
}

/** Fetch problems (cache-first, same strategy as run-humaneval.ts). */
export async function fetchProblems(offset: number, count: number): Promise<BakeoffProblem[]> {
  const cacheFile = Bun.file(CACHE_PATH);
  if (await cacheFile.exists()) {
    const all = (await cacheFile.json()) as BakeoffProblem[];
    const slice = all.slice(offset, offset + count);
    if (slice.length === count || (slice.length > 0 && offset + count > all.length)) {
      return slice;
    }
  }

  const out: BakeoffProblem[] = [];
  let got = 0;
  while (got < count) {
    const len = Math.min(100, count - got);
    const url = `${DATASET_URL}&offset=${offset + got}&length=${len}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`dataset fetch failed: HTTP ${res.status}`);
    const json = (await res.json()) as { rows: Array<{ row: BakeoffProblem }> };
    if (json.rows.length === 0) break;
    for (const r of json.rows) out.push(r.row);
    got += json.rows.length;
  }
  return out;
}

/** Resolve entry function name. */
export function entryName(prompt: string, name: string): string {
  const matches = [...prompt.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  const last = matches.at(-1);
  if (last?.[1]) return last[1];
  return name.replace(/^HumanEval_\d+_/, "");
}

/** Add `export` to target function. */
export function exportedStub(prompt: string, entry: string): string {
  if (new RegExp(`export\\s+function\\s+${entry}\\b`).test(prompt)) return prompt;
  return prompt.replace(new RegExp(`function\\s+${entry}\\b`), `export function ${entry}`);
}

/** Build a `bun:test` file from MultiPL-E test body. */
export function buildTestFile(tests: string, entry: string, name: string): string {
  let body = tests.replace(/function\s+test\s*\(\s*\)/, "function __bo_test()");
  body = body.replace(/\n\s*test\s*\(\s*\)\s*;?\s*$/, "\n");
  return [
    `import { test as __it } from "bun:test";`,
    `import { ${entry} } from "../src/solution.ts";`,
    ``,
    body.trim(),
    ``,
    `__it(${JSON.stringify(name)}, () => { __bo_test(); });`,
    ``,
  ].join("\n");
}

/** Run `bun test` in dir. */
export function runBunTest(dir: string): boolean {
  const proc = Bun.spawnSync(["bun", "test"], { cwd: dir, timeout: 60_000 });
  const out =
    (proc.stdout instanceof Uint8Array ? new TextDecoder().decode(proc.stdout) : "") +
    (proc.stderr instanceof Uint8Array ? new TextDecoder().decode(proc.stderr) : "");
  const failMatch = out.match(/(\d+)\s+fail/i);
  const failCount = failMatch ? parseInt(failMatch[1] ?? "0", 10) : 0;
  return proc.exitCode === 0 && failCount === 0;
}

/**
 * Injectable runner: receives (modelId, stub, entry) → solution file content.
 * Tests inject a fake; production uses the agent loop.
 */
export type RunnerFn = (modelId: string, stub: string, entry: string) => Promise<string>;

/** Stub runner for dry-run / tests: always returns the unimplemented stub. */
export const stubRunner: RunnerFn = async (_modelId, stub) => stub;

export interface ModelResult {
  modelId: string;
  /** pass[problem][trial] */
  passes: boolean[][];
  problemNames: string[];
}

export interface BakeoffStats {
  modelId: string;
  n: number;
  k: number;
  pass1: number;
  passKAll: number;
  passKAny: number;
  totalPass: number;
  totalTrials: number;
  allKProblems: number;
  anyKProblems: number;
}

/** Compute per-model stats from a ModelResult. */
export function computeStats(result: ModelResult, k: number): BakeoffStats {
  const n = result.passes.length;
  const totalTrials = n * k;
  const totalPass = result.passes.reduce((s, pp) => s + pp.filter(Boolean).length, 0);
  const allK = result.passes.filter((pp) => pp.every(Boolean)).length;
  const anyK = result.passes.filter((pp) => pp.some(Boolean)).length;
  return {
    modelId: result.modelId,
    n,
    k,
    pass1: totalTrials > 0 ? totalPass / totalTrials : 0,
    passKAll: n > 0 ? allK / n : 0,
    passKAny: n > 0 ? anyK / n : 0,
    totalPass,
    totalTrials,
    allKProblems: allK,
    anyKProblems: anyK,
  };
}

/**
 * Format a comparison table (markdown-ish, fixed-width columns).
 *
 * | model                | pass@1 | pass^k (all) | pass@k (any) |
 * |----------------------|--------|--------------|--------------|
 * | vibethinker-3b       | 0.828  | 0.748        | 0.906        |
 */
export function formatTable(stats: BakeoffStats[], k: number): string {
  const header = [
    "model".padEnd(30),
    "pass@1".padEnd(10),
    `pass^${k} (all)`.padEnd(16),
    `pass@${k} (any)`.padEnd(16),
    "problems".padEnd(10),
  ].join(" | ");

  const sep = "-".repeat(header.length);

  const rows = stats.map((s) =>
    [
      s.modelId.padEnd(30),
      s.pass1.toFixed(3).padEnd(10),
      s.passKAll.toFixed(3).padEnd(16),
      s.passKAny.toFixed(3).padEnd(16),
      String(s.n).padEnd(10),
    ].join(" | "),
  );

  return [header, sep, ...rows].join("\n");
}

/**
 * Run a single model against the problems using the provided runner.
 * Returns ModelResult with per-problem per-trial pass/fail booleans.
 */
export async function runModel(
  modelId: string,
  problems: BakeoffProblem[],
  k: number,
  runner: RunnerFn,
  onProgress?: (problemIdx: number, problemName: string, passes: boolean[]) => void,
): Promise<ModelResult> {
  const passesByProblem: boolean[][] = [];
  const problemNames: string[] = [];

  for (let p = 0; p < problems.length; p++) {
    const prob = problems[p]!;
    const entry = entryName(prob.prompt, prob.name);
    const stub = exportedStub(prob.prompt, entry);
    const testFile = buildTestFile(prob.tests, entry, prob.name);
    const passes: boolean[] = [];

    for (let trial = 0; trial < k; trial++) {
      const dir = await mkdtemp(join(tmpdir(), "smallcode-bo-"));
      let passed = false;
      try {
        await mkdir(join(dir, "src"), { recursive: true });
        await mkdir(join(dir, "tests"), { recursive: true });
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "bo", module: "src/solution.ts", type: "module" }, null, 2),
          "utf-8",
        );

        let solution: string;
        try {
          solution = await runner(modelId, stub, entry);
        } catch (err) {
          console.error(
            `    [${modelId}] ${prob.name} trial ${trial} (runner): ${err instanceof Error ? err.message : err}`,
          );
          passes.push(false);
          continue;
        }

        await writeFile(join(dir, "src", "solution.ts"), solution, "utf-8");
        await writeFile(join(dir, "tests", "solution.test.ts"), testFile, "utf-8");
        passed = runBunTest(dir);
      } catch (err) {
        console.error(
          `    [${modelId}] ${prob.name} trial ${trial}: ${err instanceof Error ? err.message : err}`,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      passes.push(passed);
    }

    passesByProblem.push(passes);
    problemNames.push(prob.name);
    onProgress?.(p, prob.name, passes);
  }

  return { modelId, passes: passesByProblem, problemNames };
}

async function main(): Promise<void> {
  // Parse model IDs and flags from argv
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dryRun =
    process.argv.includes("--dry-run") || process.env.SMALLCODE_BO_DRY_RUN === "1";

  if (args.length === 0) {
    console.error("[bakeoff] Usage: bun scripts/run-bakeoff.ts [--dry-run] <modelId> [modelId ...]");
    process.exit(1);
  }

  // Validate model IDs through registry (never call them).
  const registry = defaultRegistry;
  const validIds: string[] = [];
  for (const id of args) {
    if (registry.has(id)) {
      validIds.push(id);
    } else {
      console.warn(`[bakeoff] WARNING: unknown model "${id}" — skipping. Known: ${registry.list().map((m) => m.id).join(", ")}`);
    }
  }
  if (validIds.length === 0) {
    console.error("[bakeoff] No valid model IDs. Aborting.");
    process.exit(1);
  }

  console.log(
    `[bakeoff] models: ${validIds.join(", ")} | problems ${OFFSET}..${OFFSET + LIMIT - 1} | k=${K}${dryRun ? " | DRY-RUN" : ""}`,
  );

  const problems = await fetchProblems(OFFSET, LIMIT);
  console.log(`[bakeoff] fetched ${problems.length} problems\n`);

  let runner: RunnerFn;
  if (dryRun) {
    runner = stubRunner;
  } else {
    const { loadConfig } = await import("../src/config/loader.ts");
    const { createProvider } = await import("../src/provider/factory.ts");
    const { ReasoningHandler } = await import("../src/reasoning/handler.ts");
    const { runLoop } = await import("../src/agent/loop.ts");
    const { createState, getStatePath } = await import("../src/agent/state.ts");

    const { config, extraModels } = loadConfig();
    for (const m of extraModels) registry.register(m);

    runner = async (modelId: string, stub: string): Promise<string> => {
      const profile = registry.get(modelId);
      const provider = createProvider(config.provider, registry);
      const reasoningHandler = new ReasoningHandler(
        profile.reasoningTags ?? { open: "<think>", close: "</think>" },
      );

      const dir = await mkdtemp(join(tmpdir(), "smallcode-bo-solve-"));
      try {
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "solution.ts"), stub, "utf-8");
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "bo", module: "src/solution.ts", type: "module" }, null, 2),
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

  const allStats: BakeoffStats[] = [];

  for (const modelId of validIds) {
    console.log(`\n[bakeoff] ---- ${modelId} ----`);
    const result = await runModel(
      modelId,
      problems,
      K,
      runner,
      (p, name, passes) => {
        const np = passes.filter(Boolean).length;
        const sym = np === K ? "✓" : np === 0 ? "✗" : "~";
        console.log(`  [${p + 1}/${problems.length}] ${name}: ${np}/${K} ${sym}`);
      },
    );
    allStats.push(computeStats(result, K));
  }

  console.log(`\n[bakeoff] ===== COMPARISON TABLE =====`);
  console.log(formatTable(allStats, K));
  console.log(`\n  problems: ${problems.length} | k=${K}`);
}

if (import.meta.main)
  main().catch((err: unknown) => {
    console.error("[bakeoff] ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
