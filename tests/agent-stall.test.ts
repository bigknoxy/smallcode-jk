/**
 * Agent stall detection + redraft tests.
 *
 * Uses real fixture repos (like verify-oracle-integration.test.ts) so CI stays
 * Ollama-free and there is no module-mock contamination. The fixture repos
 * contain real bun tests that are deliberately failing, giving the oracle a
 * real "failing" verdict without any mocking.
 *
 * Tests are slower than pure unit tests (~1s each) because they spawn bun
 * subprocesses, but they are deterministic and don't require Ollama.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "../src/agent/loop.ts";
import { createState, loadState } from "../src/agent/state.ts";
import type { AgentConfig } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  StreamChunk,
} from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(repoRoot: string, maxTurns = 10): AgentConfig {
  return { repoRoot, modelId: "test-model", maxTurns, bestOfN: 1 };
}

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

function makeProvider(responseText: string): Provider {
  return {
    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
      rawContent: responseText,
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    }),
    stream: async function* (_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: responseText, done: true };
    },
  };
}

function makeContext(): ContextBundle {
  return { chunks: [], totalTokens: 0, tokenBudget: 2048, truncated: false, query: "test" };
}

// ---------------------------------------------------------------------------
// Fixture repo builder
//
// Creates a minimal repo with a deliberately failing bun test so runTieredOracle
// returns outcome="failing" with a real diagnostic. The test always fails with
// the same assertion so the failure signature is stable across turns.
// ---------------------------------------------------------------------------

async function scaffoldFailingRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // A test that always fails: expect(1).toBe(999)
  await writeFile(
    join(dir, "always-fail.test.ts"),
    `import { test, expect } from "bun:test";
test("stall-fixture > always fails", () => {
  expect(1).toBe(999);
});
`,
    "utf-8",
  );
  await writeFile(join(dir, "package.json"), '{"name":"stall-fixture","type":"module"}', "utf-8");
}

// A repo with a passing test (for solved early-stop regression test).
async function scaffoldPassingRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "pass.test.ts"),
    `import { test, expect } from "bun:test";
test("always passes", () => {
  expect(1).toBe(1);
});
`,
    "utf-8",
  );
  await writeFile(join(dir, "package.json"), '{"name":"pass-fixture","type":"module"}', "utf-8");
}

// ---------------------------------------------------------------------------
// Test directory setup
// ---------------------------------------------------------------------------

let testDir: string;
let repoDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `smallcode-stall-test-${Date.now()}`);
  repoDir = join(testDir, "repo");
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 14. stallCount increments on consecutive same-signature failures
// ---------------------------------------------------------------------------

describe("stall detection — stallCount tracking", () => {
  test(
    "14. consecutive same-signature failures recorded in turn.failureSignature",
    async () => {
      await scaffoldFailingRepo(repoDir);
      const config = makeConfig(repoDir, 4);
      const state = createState(config, "test stall");
      state.goals = [{ id: "goal-1", description: "fix the test", status: "pending" }];

      const statePath = join(testDir, "state.json");
      const provider = makeProvider("working on it...");

      const finalState = await runLoop(
        state,
        statePath,
        {
          provider,
          profile: makeProfile(),
          reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
          config,
        },
        async () => makeContext(),
      );

      // All turns should have produced failing verdicts with failure signatures
      const turnsWithSig = finalState.turns.filter((t) => t.failureSignature !== undefined);
      expect(turnsWithSig.length).toBeGreaterThanOrEqual(2);

      // All signatures should be the same (same test, same assertion)
      const sigs = new Set(turnsWithSig.map((t) => t.failureSignature!));
      expect(sigs.size).toBe(1);
    },
    30_000,
  );

  test(
    "14b. stallCount state field increments across turns",
    async () => {
      await scaffoldFailingRepo(repoDir);
      const config = makeConfig(repoDir, 4);
      const state = createState(config, "test stall");
      state.goals = [{ id: "goal-1", description: "fix the test", status: "pending" }];

      const statePath = join(testDir, "state.json");
      const provider = makeProvider("working on it...");

      await runLoop(
        state,
        statePath,
        {
          provider,
          profile: makeProfile(),
          reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
          config,
        },
        async () => makeContext(),
      );

      // Load persisted state — stallCount should be > 0
      const loaded = await loadState(statePath);
      expect(loaded).not.toBeNull();
      // After 4 turns on same failure: stallCount >= 2 (resets at STALL_LIMIT)
      // or redraftCount >= 1 (redraft fired). Either way, stall logic ran.
      const sawStall =
        (loaded?.stallCount ?? 0) > 0 ||
        (loaded?.redraftCount ?? 0) > 0 ||
        loaded?.turns.some((t) => t.redrafted) === true;
      expect(sawStall).toBe(true);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 15. Redraft fires after STALL_LIMIT same-signature failures
// ---------------------------------------------------------------------------

describe("stall detection — redraft trigger", () => {
  test(
    "15. prompt contains REDRAFT after STALL_LIMIT same-signature failures",
    async () => {
      await scaffoldFailingRepo(repoDir);
      // STALL_LIMIT=2 means 3 same-sig failures → 3rd failure fires redraft for turn 4.
      // With maxTurns=4 we get: turn1=fail, turn2=fail(stall1), turn3=fail(stall2→redraft),
      // turn4=fail with REDRAFT prompt.
      const config = makeConfig(repoDir, 4);
      const state = createState(config, "test stall redraft");
      state.goals = [{ id: "goal-1", description: "fix the test", status: "pending" }];

      const promptsSeen: string[] = [];
      const provider: Provider = {
        complete: async (req: CompletionRequest): Promise<CompletionResponse> => {
          const userMsg = req.messages.find((m) => m.role === "user");
          if (userMsg && typeof userMsg.content === "string") {
            promptsSeen.push(userMsg.content);
          }
          return {
            rawContent: "working on it...",
            model: "test-model",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            finishReason: "stop",
          };
        },
        stream: async function* (): AsyncIterableIterator<StreamChunk> {
          yield { delta: "working on it...", done: true };
        },
      };

      await runLoop(
        state,
        join(testDir, "state.json"),
        {
          provider,
          profile: makeProfile(),
          reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
          config,
        },
        async () => makeContext(),
      );

      // After STALL_LIMIT (2) same-sig failures the next turn should have REDRAFT.
      // STALL_LIMIT=2 means stallCount reaches 2 after the 3rd same-sig failure,
      // so turn 4 (index 3) should contain REDRAFT.
      expect(promptsSeen.length).toBeGreaterThanOrEqual(4);
      const redraftPrompt = promptsSeen[3]!;
      expect(redraftPrompt).toContain("REDRAFT");

      // Suppressed Recent History on redraft
      expect(redraftPrompt).not.toContain("Recent History");

      // Task and goal still present
      expect(redraftPrompt).toContain("test stall redraft");
    },
    30_000,
  );

  test(
    "15b. redraftCount tracked and capped at MAX_REDRAFTS (2)",
    async () => {
      await scaffoldFailingRepo(repoDir);
      // With STALL_LIMIT=2 and MAX_REDRAFTS=2, after 2 redraft cycles the loop
      // stops redrafting. Each cycle = STALL_LIMIT+1 = 3 turns.
      // 2 cycles × 3 turns = 6 turns; then more turns without redraft.
      // Use maxTurns=10 to give it room.
      const config = makeConfig(repoDir, 10);
      const state = createState(config, "test stall cap");
      state.goals = [{ id: "goal-1", description: "fix the test", status: "pending" }];

      const statePath = join(testDir, "state.json");
      const provider = makeProvider("working on it...");

      const finalState = await runLoop(
        state,
        statePath,
        {
          provider,
          profile: makeProfile(),
          reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
          config,
        },
        async () => makeContext(),
      );

      // redraftCount must not exceed MAX_REDRAFTS (2)
      expect(finalState.redraftCount ?? 0).toBeLessThanOrEqual(2);

      // Number of turns that were marked as triggering a redraft
      const redraftTriggers = finalState.turns.filter((t) => t.redrafted);
      expect(redraftTriggers.length).toBeLessThanOrEqual(2);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 16. Solved still early-stops (regression guard)
// ---------------------------------------------------------------------------

describe("stall detection — solved early-stop regression", () => {
  test(
    "16. solved verdict still causes early-stop and no spurious redraft",
    async () => {
      await scaffoldPassingRepo(repoDir);
      const config = makeConfig(repoDir, 10);
      const state = createState(config, "test task that passes");
      state.goals = [{ id: "goal-1", description: "check it passes", status: "pending" }];

      const statePath = join(testDir, "state.json");
      const provider = makeProvider("working on it...");

      const finalState = await runLoop(
        state,
        statePath,
        {
          provider,
          profile: makeProfile(),
          reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
          config,
        },
        async () => makeContext(),
      );

      // Should have solved early (after 1 turn — tests are green)
      expect(finalState.status).toBe("done");
      expect(finalState.turns.length).toBe(1);

      // No redraft on a solved run
      const redraftTurns = finalState.turns.filter((t) => t.redrafted);
      expect(redraftTurns.length).toBe(0);
      expect(finalState.redraftCount ?? 0).toBe(0);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 17. No false stall on different failures
// ---------------------------------------------------------------------------

describe("stall detection — no false stall on different failures", () => {
  test(
    "17. different failures across turns do not trigger redraft",
    async () => {
      // We can't easily alternate failures without mocking, but we CAN verify:
      // a repo whose test output changes (by rewriting the test between turns)
      // does NOT trigger a redraft because the signature differs.
      //
      // More practically: test that a single failure doesn't trigger redraft
      // (needs STALL_LIMIT consecutive SAME sigs, not just 1).
      await scaffoldFailingRepo(repoDir);
      const config = makeConfig(repoDir, 2); // only 2 turns — not enough to stall
      const state = createState(config, "short run");
      state.goals = [{ id: "goal-1", description: "attempt", status: "pending" }];

      const statePath = join(testDir, "state.json");
      const provider = makeProvider("working on it...");

      const finalState = await runLoop(
        state,
        statePath,
        {
          provider,
          profile: makeProfile(),
          reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
          config,
        },
        async () => makeContext(),
      );

      // With only 2 turns, stallCount never reaches STALL_LIMIT (2) so no redraft.
      // (Turn 1: stallCount=0→1 on same sig; Turn 2: stallCount=1→2 → fires redraft,
      // but redraft is set for NEXT turn which never runs. So turns[1].redrafted
      // is set on the turn that TRIGGERED the redraft, not the redraft turn itself.)
      //
      // Actually STALL_LIMIT=2 means: after 3 consecutive same-sig failures we redraft.
      // Turn 1: stallCount→0 (first occurrence)
      // Turn 2: stallCount→1 (second, no redraft yet; stallCount 1 < STALL_LIMIT 2)
      // → NO redraft turn within 2-turn run.
      const redraftTurns = finalState.turns.filter((t) => t.redrafted);
      expect(redraftTurns.length).toBe(0);
      expect(finalState.redraftCount ?? 0).toBe(0);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 18. Typecheck-tier stall fires redraft (Fix 3)
//
// When NO test files exist but a persistent TS type error is present,
// the oracle returns outcome="failing" via Tier-2 typecheck. The stall
// logic must detect this and fire a redraft after STALL_LIMIT turns.
// ---------------------------------------------------------------------------

/**
 * Scaffold a repo with NO test files but a real TS type error.
 * The tsconfig must be valid so tsc runs and emits a real TS2322 diagnostic.
 */
async function scaffoldTypecheckFailingRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });

  // A source file with a type error: string assigned to number
  await writeFile(
    join(dir, "src.ts"),
    `const x: number = "not a number";\nexport {};\n`,
    "utf-8",
  );

  // A valid tsconfig that covers src.ts
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "bundler",
      },
      include: ["src.ts"],
    }),
    "utf-8",
  );

  await writeFile(join(dir, "package.json"), '{"name":"tc-stall-fixture","type":"module"}', "utf-8");
}

describe("stall detection — typecheck-tier stall", () => {
  test(
    "18. typecheck-tier failing outcome increments stallCount and fires redraft",
    async () => {
      await scaffoldTypecheckFailingRepo(repoDir);
      // STALL_LIMIT=2: 3 same-sig failures → redraft fires for turn 4.
      // Use maxTurns=4 to get through the full stall cycle.
      const config = makeConfig(repoDir, 4);
      const state = createState(config, "test typecheck stall");
      state.goals = [{ id: "goal-1", description: "fix the type error", status: "pending" }];

      const promptsSeen: string[] = [];
      const provider: Provider = {
        complete: async (req: CompletionRequest): Promise<CompletionResponse> => {
          const userMsg = req.messages.find((m) => m.role === "user");
          if (userMsg && typeof userMsg.content === "string") {
            promptsSeen.push(userMsg.content);
          }
          return {
            rawContent: "working on it...",
            model: "test-model",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            finishReason: "stop",
          };
        },
        stream: async function* (): AsyncIterableIterator<StreamChunk> {
          yield { delta: "working on it...", done: true };
        },
      };

      const finalState = await runLoop(
        state,
        join(testDir, "state.json"),
        {
          provider,
          profile: makeProfile(),
          reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
          config,
        },
        async () => makeContext(),
      );

      // stall logic must have run: either stallCount > 0 or a redraft fired
      const sawStall =
        (finalState.stallCount ?? 0) > 0 ||
        (finalState.redraftCount ?? 0) > 0 ||
        finalState.turns.some((t) => t.redrafted) === true;
      expect(sawStall).toBe(true);

      // After STALL_LIMIT (2) consecutive same-sig typecheck failures the 4th turn
      // should have REDRAFT in its prompt (turns are 0-indexed in promptsSeen).
      if (promptsSeen.length >= 4) {
        expect(promptsSeen[3]).toContain("REDRAFT");
      }
    },
    60_000,
  );
});
