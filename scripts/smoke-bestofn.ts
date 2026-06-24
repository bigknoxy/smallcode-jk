#!/usr/bin/env bun
/**
 * Live smoke test for run-level oracle-verified Best-of-N.
 *
 * Picks a known high-variance HumanEval-TS problem (default flip_case @27, which
 * scored 1/3 single-shot in the clean run), then runs ONE Best-of-N(N) attempt:
 * up to N independent full agent-loop runs at swept temperatures, fresh dir each,
 * first `bun test` green wins. Prints whether BoN passed and on which attempt.
 *
 * Quick verification only — not a full benchmark cycle.
 *   SMALLCODE_SMOKE_OFFSET=27  SMALLCODE_SMOKE_N=3  bun scripts/smoke-bestofn.ts
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { defaultRegistry } from "../src/models/registry.ts";
import { createProvider } from "../src/provider/factory.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import { createState, getStatePath } from "../src/agent/state.ts";
import { runBestOfNLoop, defaultTemperatures } from "../src/agent/bestofn-loop.ts";
import { fetchProblems, entryName, exportedStub, buildTestFile, runBunTest } from "./run-humaneval.ts";
import type { ContextBundle } from "../src/context/types.ts";

const OFFSET = Number(process.env.SMALLCODE_SMOKE_OFFSET ?? "27");
const N = Number(process.env.SMALLCODE_SMOKE_N ?? "3");
const MAX_TURNS = Number(process.env.SMALLCODE_SMOKE_MAX_TURNS ?? "5");

const [prob] = await fetchProblems(OFFSET, 1);
if (!prob) throw new Error(`no problem at offset ${OFFSET}`);
const entry = entryName(prob.prompt, prob.name);
const stub = exportedStub(prob.prompt, entry);
const testFile = buildTestFile(prob.tests, entry, prob.name);

const { config, extraModels } = loadConfig();
for (const m of extraModels) defaultRegistry.register(m);
const profile = defaultRegistry.get(config.activeModel);
const provider = createProvider(config.provider, defaultRegistry);
const reasoningHandler = new ReasoningHandler(
  profile.reasoningTags ?? { open: "<think>", close: "</think>" },
);

console.log(`[smoke] ${prob.name} | Best-of-N=${N} | temps=${defaultTemperatures(N).join(",")}`);

// Each attempt gets its own fresh trial dir (independent — no inherited edits).
const dirs: string[] = [];
async function buildDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "smoke-bon-"));
  dirs.push(dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "tests"), { recursive: true });
  await writeFile(join(dir, "src", "solution.ts"), stub, "utf-8");
  await writeFile(join(dir, "tests", "solution.test.ts"), testFile, "utf-8");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "smoke", module: "src/solution.ts", type: "module" }),
    "utf-8",
  );
  return dir;
}

const attemptDirs: string[] = [];
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

try {
  const result = await runBestOfNLoop({
    n: N,
    deps: { provider, profile, reasoningHandler, config: {} as never },
    setup: async (i) => {
      const dir = await buildDir();
      attemptDirs[i] = dir;
      const agentConfig = {
        repoRoot: dir,
        modelId: profile.id,
        maxTurns: MAX_TURNS,
        bestOfN: 1,
        statePath: join(dir, ".smallcode", "state.json"),
        allowedCommands: config.sandbox.allowedCommands,
        requireApproval: false,
      };
      const state = createState(agentConfig, "Implement the body of the function in src/solution.ts. Output the complete file.");
      return { state, statePath: getStatePath(agentConfig), getContext };
    },
    verify: async (i) => {
      const green = runBunTest(attemptDirs[i]!);
      console.log(`[smoke]   attempt ${i} (temp ${defaultTemperatures(N)[i]}): ${green ? "GREEN ✓" : "red ✗"}`);
      return green;
    },
  });

  console.log(
    `\n[smoke] RESULT: ${result.passed ? "PASS" : "FAIL"} | attempts used ${result.attemptsUsed}/${N}` +
      (result.passed ? ` | winner attempt ${result.winningAttempt} (temp ${result.temperatures[result.winningAttempt!]})` : ""),
  );
} finally {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}
