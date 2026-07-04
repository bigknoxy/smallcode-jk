import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, runLoop } from "../src/agent/index.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// ---------------------------------------------------------------------------
// Lever B — harness-side STATEMENT-REPAIR (SMALLCODE_STATEMENT_REPAIR).
//
// A sub-14B model fixing an LRU cache localizes the read-after-delete bug
// perfectly yet keeps writing `X.delete(K); X.set(K, X.get(K))` — the read runs
// AFTER the delete, so it re-inserts undefined. No operator flip fixes an
// ordering mistake. When the model loop ends UNSOLVED in fix-mode with a locked
// target, this last-resort pass deterministically hoists the read into a temp
// before the delete, runs the real oracle, and keeps it if fully green. It is
// recorded as a harness rescue (mutationRepair) so pass-quality classification
// attributes the solve to the harness, not the model.
// ---------------------------------------------------------------------------

function makeProfile(): ModelProfile {
  return {
    id: "test-model",
    label: "Test Model",
    contextWindow: 4096,
    samplingDefaults: { temperature: 0.2, top_p: 0.9, top_k: -1, max_tokens: 1024 },
    supportsGrammar: false,
    supportsJsonSchema: false,
  };
}

function makeSequentialProvider(responses: string[]): Provider {
  let call = 0;
  return {
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => {
      const text = responses[Math.min(call, responses.length - 1)] ?? "";
      call++;
      return {
        rawContent: text,
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      };
    },
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "", done: true };
    },
  };
}

const TARGET_PATH = "src/cache.ts";

// LRU cache whose get() re-inserts the key to bump recency but READS it AFTER
// deleting it (`map.set(key, map.get(key))`), so the stored value becomes
// undefined and a subsequent get returns undefined — the baseline red.
const BUGGY_SOURCE = `export function makeCache() {
  const map = new Map();
  return {
    set(key, value) { map.set(key, value); },
    get(key) {
      if (!map.has(key)) return undefined;
      map.delete(key);
      map.set(key, map.get(key));
      return map.get(key);
    },
  };
}
`;

// The model "fixes" it but reintroduces the exact same ordering bug (never
// hoists the read) — a faithful stand-in for the documented sub-14B behavior.
const STILL_BUGGY_SOURCE = `export function makeCache() {
  const map = new Map();
  return {
    set(key, value) { map.set(key, value); },
    get(key) {
      if (!map.has(key)) {
        return undefined;
      }
      map.delete(key);
      map.set(key, map.get(key));
      return map.get(key);
    },
  };
}
`;

function makeTargetContext(): ContextBundle {
  return {
    chunks: [
      { filePath: TARGET_PATH, startLine: 1, endLine: 12, content: BUGGY_SOURCE, estimatedTokens: 40, pinned: true },
    ],
    totalTokens: 40,
    tokenBudget: 4096,
    truncated: false,
    query: "fix get in src/cache.ts",
    targetFile: { path: TARGET_PATH, lineCount: 12, format: "full" },
  };
}

let testDir: string;
let priorMutationRepair: string | undefined;
let priorStatementRepair: string | undefined;
let priorRadHint: string | undefined;

async function setupRepo(): Promise<void> {
  testDir = join(tmpdir(), `smallcode-stmt-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
  await writeFile(join(testDir, "src", "cache.ts"), BUGGY_SOURCE, "utf-8");
  await writeFile(
    join(testDir, "tests", "cache.test.ts"),
    'import { test, expect } from "bun:test";\nimport { makeCache } from "../src/cache.ts";\ntest("get preserves the value after recency bump", () => {\n  const c = makeCache();\n  c.set("a", 1);\n  expect(c.get("a")).toBe(1);\n});\n',
    "utf-8",
  );
}

beforeEach(() => {
  // Isolate from the default-on operator-mutation repair (an ordering bug is a
  // disjoint shape it can't fix, but keep the loop behavior measured cleanly),
  // and pin the two new flags so ambient env can't perturb the assertions.
  priorMutationRepair = process.env["SMALLCODE_MUTATION_REPAIR"];
  priorStatementRepair = process.env["SMALLCODE_STATEMENT_REPAIR"];
  priorRadHint = process.env["SMALLCODE_RAD_HINT"];
  process.env["SMALLCODE_MUTATION_REPAIR"] = "0";
});

afterEach(async () => {
  if (priorMutationRepair === undefined) delete process.env["SMALLCODE_MUTATION_REPAIR"];
  else process.env["SMALLCODE_MUTATION_REPAIR"] = priorMutationRepair;
  if (priorStatementRepair === undefined) delete process.env["SMALLCODE_STATEMENT_REPAIR"];
  else process.env["SMALLCODE_STATEMENT_REPAIR"] = priorStatementRepair;
  if (priorRadHint === undefined) delete process.env["SMALLCODE_RAD_HINT"];
  else process.env["SMALLCODE_RAD_HINT"] = priorRadHint;
  await rm(testDir, { recursive: true, force: true });
});

function makeConfig(): AgentConfig {
  return { repoRoot: testDir, modelId: "test-model", maxTurns: 2, bestOfN: 1 };
}

function makeRun() {
  const state = createState(makeConfig(), "Fix get() in src/cache.ts so the failing test passes");
  state.goals = [{ id: "goal-1", description: "Fix get in src/cache.ts", status: "pending" }];
  const responses = [
    `FILE: ${TARGET_PATH}\n\`\`\`ts\n${STILL_BUGGY_SOURCE}\`\`\`\nTOOL: finish {"summary": "fixed it"}`,
  ];
  return {
    state,
    deps: {
      provider: makeSequentialProvider(responses),
      profile: makeProfile(),
      reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
      config: makeConfig(),
    },
    statePath: join(testDir, "state.json"),
  };
}

describe("Lever B — statement-repair", () => {
  it("rescues the read-after-delete bug and records it as a harness mutationRepair when SMALLCODE_STATEMENT_REPAIR=1", async () => {
    process.env["SMALLCODE_STATEMENT_REPAIR"] = "1";
    await setupRepo();
    const { state, deps, statePath } = makeRun();

    const finalState = await runLoop(state, statePath, deps, async () => makeTargetContext());

    expect(finalState.status).toBe("done");
    expect(finalState.verified).toBe(true);

    const lastTurn = finalState.turns.at(-1);
    expect(lastTurn?.mutationRepair).toBeDefined();
    expect(lastTurn?.mutationRepair?.label).toBe("read-after-delete hoist");

    // The winning candidate is left on disk (it IS the fix).
    const onDisk = await readFile(join(testDir, "src", "cache.ts"), "utf-8");
    expect(onDisk).toContain("__radVal");
  });

  it("leaves the run UNSOLVED and appends no statement-repair turn when the flag is OFF", async () => {
    delete process.env["SMALLCODE_STATEMENT_REPAIR"];
    await setupRepo();
    const { state, deps, statePath } = makeRun();

    const finalState = await runLoop(state, statePath, deps, async () => makeTargetContext());

    expect(finalState.verified).not.toBe(true);
    expect(finalState.turns.some((t) => t.mutationRepair !== undefined)).toBe(false);
    // The file was never hoisted — the bug remains on disk.
    const onDisk = await readFile(join(testDir, "src", "cache.ts"), "utf-8");
    expect(onDisk).not.toContain("__radVal");
  });
});

// ---------------------------------------------------------------------------
// Reverted-attempt recovery (the real-world lru-recency condition).
//
// The mock above never triggers a REVERT: its baseline is already red on the
// only test, so the model's still-red edit regresses nothing and stays on disk.
// The real lru task differs — the model's read-after-delete stores undefined,
// which regresses a basic-get test that was GREEN at baseline, so the loop
// reverts the edit and disk returns to pristine (a `return map.get(key)` with no
// delete to hoist). Both levers must therefore inspect the model's ATTEMPT from
// turn history, not disk. This block reproduces that revert and asserts the fix.
// ---------------------------------------------------------------------------

const REVERT_TARGET = "src/lru.ts";
// Baseline: basic get works (green), but get() never refreshes recency (red).
const REVERT_BASELINE = `export function makeLru(limit) {
  const map = new Map();
  return {
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > limit) map.delete(map.keys().next().value);
    },
    get(key) {
      return map.get(key);
    },
  };
}
`;
// Model attempt: adds recency structure but READS after DELETE → stores undefined,
// so basic get returns undefined → the previously-green basic-get test flips red
// → the loop REVERTS this edit off disk.
const REVERT_ATTEMPT = `export function makeLru(limit) {
  const map = new Map();
  return {
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > limit) map.delete(map.keys().next().value);
    },
    get(key) {
      if (!map.has(key)) return undefined;
      map.delete(key);
      map.set(key, map.get(key));
      return map.get(key);
    },
  };
}
`;

function makeRevertContext(): ContextBundle {
  return {
    chunks: [
      { filePath: REVERT_TARGET, startLine: 1, endLine: 16, content: REVERT_BASELINE, estimatedTokens: 60, pinned: true },
    ],
    totalTokens: 60,
    tokenBudget: 4096,
    truncated: false,
    query: "fix get recency in src/lru.ts",
    targetFile: { path: REVERT_TARGET, lineCount: 16, format: "full" },
  };
}

describe("Lever B — statement-repair recovers a REVERTED attempt", () => {
  it("rescues the read-after-delete even after the loop reverted it off disk (reads the attempt from turn history, not pristine disk)", async () => {
    process.env["SMALLCODE_STATEMENT_REPAIR"] = "1";
    testDir = join(tmpdir(), `smallcode-stmt-revert-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, "src"), { recursive: true });
    await mkdir(join(testDir, "tests"), { recursive: true });
    await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
    await writeFile(join(testDir, "src", "lru.ts"), REVERT_BASELINE, "utf-8");
    // Two tests: basic-get is GREEN at baseline (its regression triggers the revert),
    // recency is RED at baseline (the bug the task targets). Statement-repair must
    // make BOTH pass by hoisting the read in the model's reverted attempt.
    await writeFile(
      join(testDir, "tests", "lru.test.ts"),
      'import { test, expect } from "bun:test";\nimport { makeLru } from "../src/lru.ts";\n' +
        'test("get returns the stored value", () => {\n  const c = makeLru(2);\n  c.set("a", 1);\n  expect(c.get("a")).toBe(1);\n});\n' +
        'test("recently-read key survives eviction", () => {\n  const c = makeLru(2);\n  c.set("a", 1); c.set("b", 2);\n  c.get("a");\n  c.set("c", 3);\n  expect(c.get("a")).toBe(1);\n  expect(c.get("b")).toBeUndefined();\n});\n',
      "utf-8",
    );

    const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 2, bestOfN: 1 };
    const state = createState(config, "Fix get() recency in src/lru.ts");
    state.goals = [{ id: "goal-1", description: "Fix get recency in src/lru.ts", status: "pending" }];
    const responses = [
      `FILE: ${REVERT_TARGET}\n\`\`\`ts\n${REVERT_ATTEMPT}\`\`\`\nTOOL: finish {"summary": "added recency"}`,
    ];
    const deps = {
      provider: makeSequentialProvider(responses),
      profile: makeProfile(),
      reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
      config,
    };
    const statePath = join(testDir, "state.json");

    const finalState = await runLoop(state, statePath, deps, async () => makeRevertContext());

    // The model's edit was reverted (it regressed the basic-get test)...
    expect(finalState.turns.some((t) => t.reverted && t.reverted.newFailures.length > 0)).toBe(true);
    // ...yet statement-repair recovered the attempt from history and solved it.
    expect(finalState.status).toBe("done");
    expect(finalState.verified).toBe(true);
    expect(finalState.turns.at(-1)?.mutationRepair?.label).toBe("read-after-delete hoist");
    const onDisk = await readFile(join(testDir, "src", "lru.ts"), "utf-8");
    expect(onDisk).toContain("__radVal");
  });
});

describe("Lever A — read-after-delete hint stashing", () => {
  it("stashes readAfterDelete (a model-signal, NOT a mutationRepair) on the failing turn when SMALLCODE_RAD_HINT=1", async () => {
    process.env["SMALLCODE_RAD_HINT"] = "1";
    // Statement-repair OFF so the run stays unsolved and the failing turn is
    // inspectable (Lever A is a prompt signal, not a rescue).
    delete process.env["SMALLCODE_STATEMENT_REPAIR"];
    await setupRepo();
    const { state, deps, statePath } = makeRun();

    const finalState = await runLoop(state, statePath, deps, async () => makeTargetContext());

    const failingTurn = finalState.turns[0];
    expect(failingTurn?.readAfterDelete).toBeDefined();
    expect(failingTurn?.readAfterDelete?.object).toBe("map");
    expect(failingTurn?.readAfterDelete?.key).toBe("key");
    expect(failingTurn?.readAfterDelete?.hint).toContain("undefined");
    // It is a model-side signal — the harness did NOT record a rescue.
    expect(failingTurn?.mutationRepair).toBeUndefined();
  });

  it("does not stash readAfterDelete when SMALLCODE_RAD_HINT is OFF", async () => {
    // Default is ON since v1.7.1, so opt OUT explicitly to exercise the off path.
    process.env["SMALLCODE_RAD_HINT"] = "0";
    delete process.env["SMALLCODE_STATEMENT_REPAIR"];
    await setupRepo();
    const { state, deps, statePath } = makeRun();

    const finalState = await runLoop(state, statePath, deps, async () => makeTargetContext());

    expect(finalState.turns.every((t) => t.readAfterDelete === undefined)).toBe(true);
  });
});
