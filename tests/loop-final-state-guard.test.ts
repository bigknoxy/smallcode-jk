import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, runLoop } from "../src/agent/index.ts";
import { pristineRunSnapshot, runFinalStateGuard } from "../src/agent/loop.ts";
import type { AgentConfig, AgentState, TurnRecord } from "../src/agent/types.ts";
import type { ContextBundle } from "../src/context/types.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/index.ts";
import { captureTestBaseline, finalStateWorseThanBaseline, type TestBaseline } from "../src/verify/oracle.ts";

// ---------------------------------------------------------------------------
// Lever 1 — final-state regression guard (SMALLCODE_FINAL_STATE_GUARD).
//
// The "never leave the repo worse than found" guarantee that dogfooding exposed
// as missing: per-turn revert only rolls back EXISTING files (a brand-new file
// the model creates has no pre-edit content, so `revertOriginals` skips it and
// it stays on disk forever). A run that ends UNSOLVED after creating a junk test
// leaves the suite redder than it started. This guard recaptures the end-state
// baseline, and if it is strictly worse, restores every touched file to pristine
// and DELETES created files. Eval-neutral: unsolved stays unsolved.
// ---------------------------------------------------------------------------

// --- Pure-function tests: finalStateWorseThanBaseline -----------------------

function baseline(redCount: number, failing: string[]): TestBaseline {
  return { failingIds: new Set(failing), hadAnyTests: true, redCount, loadError: false };
}

describe("finalStateWorseThanBaseline (pure)", () => {
  it("is worse when the red count rose", () => {
    const r = finalStateWorseThanBaseline(baseline(1, ["a"]), baseline(2, ["a"]));
    expect(r.worse).toBe(true);
  });

  it("is worse when a test failing now was not failing at baseline (equal count)", () => {
    // Fixed 'a' but broke 'b' — net count equal, but 'b' is a NEW regression.
    const r = finalStateWorseThanBaseline(baseline(1, ["a"]), baseline(1, ["b"]));
    expect(r.worse).toBe(true);
    expect(r.newFailures).toEqual(["b"]);
  });

  it("is NOT worse when the end state equals the baseline", () => {
    expect(finalStateWorseThanBaseline(baseline(2, ["a", "b"]), baseline(2, ["a", "b"])).worse).toBe(false);
  });

  it("is NOT worse when the run made partial progress (fewer failures, no new ones)", () => {
    // Baseline red {a,b}; end red {a}. Real progress, never reached green — kept.
    const r = finalStateWorseThanBaseline(baseline(2, ["a", "b"]), baseline(1, ["a"]));
    expect(r.worse).toBe(false);
    expect(r.newFailures).toEqual([]);
  });
});

// --- Pure-function tests: pristineRunSnapshot -------------------------------

function turnWith(applyResults: TurnRecord["applyResults"]): TurnRecord {
  return {
    turn: 1,
    goalId: "g",
    prompt: "",
    rawResponse: "",
    answer: "",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults,
    promptTokens: 0,
    completionTokens: 0,
    timestamp: 0,
  };
}

describe("pristineRunSnapshot (pure)", () => {
  it("captures the FIRST-seen original per path and lists created files", () => {
    const state = {
      turns: [
        turnWith([
          { filePath: "src/a.ts", status: "applied", originalContent: "A0", newContent: "A1" },
          { filePath: "src/new.ts", status: "applied", newContent: "N1" }, // brand-new: no original
        ]),
        turnWith([
          // Second edit to a.ts must NOT overwrite the pristine A0 snapshot.
          { filePath: "src/a.ts", status: "applied", originalContent: "A1", newContent: "A2" },
          { filePath: "src/b.ts", status: "error", originalContent: "B0" }, // not applied → ignored
        ]),
      ],
    } as unknown as AgentState;

    const { originals, created } = pristineRunSnapshot(state);
    expect(originals.get("src/a.ts")).toBe("A0");
    expect(originals.has("src/b.ts")).toBe(false);
    expect(created).toEqual(["src/new.ts"]);
  });

  it("honors effectivePath (path-typo rescue) over the emitted filePath", () => {
    const state = {
      turns: [
        turnWith([
          { filePath: "src/typo.ts", effectivePath: "src/real.ts", status: "applied", originalContent: "R0" },
        ]),
      ],
    } as unknown as AgentState;
    const { originals } = pristineRunSnapshot(state);
    expect(originals.get("src/real.ts")).toBe("R0");
    expect(originals.has("src/typo.ts")).toBe(false);
  });
});

// --- Guard mechanism tests: runFinalStateGuard (real repo + real oracle) -----
//
// The apply layer hard-blocks test-file edits (anti-fake-green) and per-turn
// revert already rolls back regressing EXISTING-file edits, so the guard is the
// final safety NET: given a run that ended with the repo worse than baseline
// (however it got there), it restores every touched file to pristine. We drive
// the mechanism directly with a real bun-test oracle rather than relying on the
// model reaching an already-well-defended state.

const GOOD_LIB = "export const answer = 42;\n";
const BROKEN_LIB = "export const answer = 999;\n"; // flips the green baseline test red
const LIB_PATH = "src/lib.ts";
const NEW_BROKEN = "src/extra.ts";

let testDir: string;
let priorGuard: string | undefined;
let priorMut: string | undefined;

function writeRel(): (p: string, content: string) => Promise<void> {
  return async (p, content) => {
    await writeFile(join(testDir, p), content, "utf-8");
  };
}

async function setupGreenRepo(): Promise<TestBaseline> {
  testDir = join(tmpdir(), `smallcode-fsguard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
  await writeFile(join(testDir, "src", "lib.ts"), GOOD_LIB, "utf-8");
  // Baseline: one GREEN test → hadAnyTests true, redCount 0.
  await writeFile(
    join(testDir, "tests", "lib.test.ts"),
    'import { test, expect } from "bun:test";\nimport { answer } from "../src/lib.ts";\ntest("answer", () => { expect(answer).toBe(42); });\n',
    "utf-8",
  );
  return captureTestBaseline(testDir);
}

// Turn history stating "the agent edited src/lib.ts, whose pristine content was GOOD_LIB".
function stateEditedLib(): AgentState {
  return {
    repoRoot: testDir,
    turns: [turnWith([{ filePath: LIB_PATH, status: "applied", originalContent: GOOD_LIB, newContent: BROKEN_LIB }])],
  } as unknown as AgentState;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  priorGuard = process.env["SMALLCODE_FINAL_STATE_GUARD"];
  priorMut = process.env["SMALLCODE_MUTATION_REPAIR"];
  process.env["SMALLCODE_MUTATION_REPAIR"] = "0"; // isolate from the default-on repair pass
});

afterEach(async () => {
  if (priorGuard === undefined) delete process.env["SMALLCODE_FINAL_STATE_GUARD"];
  else process.env["SMALLCODE_FINAL_STATE_GUARD"] = priorGuard;
  if (priorMut === undefined) delete process.env["SMALLCODE_MUTATION_REPAIR"];
  else process.env["SMALLCODE_MUTATION_REPAIR"] = priorMut;
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

describe("runFinalStateGuard (mechanism)", () => {
  it("reverts a touched file to pristine when the end state is worse than baseline", async () => {
    const base = await setupGreenRepo();
    const state = stateEditedLib();
    // The agent left lib.ts broken on disk (green test now red) — worse than baseline.
    await writeFile(join(testDir, LIB_PATH), BROKEN_LIB, "utf-8");

    const reverted = await runFinalStateGuard(state, base, writeRel());

    expect(reverted).toBe(true);
    expect(state.finalStateReverted).toBeDefined();
    expect(state.finalStateReverted?.startRed).toBe(0);
    expect(state.finalStateReverted?.endRed).toBe(1);
    expect(state.finalStateReverted?.filesRestored).toBe(1);
    // Disk restored to pristine → suite green again.
    expect(await readFile(join(testDir, LIB_PATH), "utf-8")).toBe(GOOD_LIB);
    expect(captureTestBaseline(testDir).redCount).toBe(0);
    // E1-T3: the restore was PROVEN (bytes read back and matched), not assumed.
    expect(state.finalStateReverted?.restoreVerified).toBe(true);
  });

  it("E1-T3 fail-closed: restoreVerified is false when the read-back does NOT match", async () => {
    const base = await setupGreenRepo();
    const state = stateEditedLib();
    await writeFile(join(testDir, LIB_PATH), BROKEN_LIB, "utf-8");

    // Inject a read-back that reports stale/wrong bytes for the restored file —
    // i.e. the write silently didn't fully land. The guard must still revert but
    // must NOT claim the restore is verified.
    const lyingRead = async (_p: string): Promise<string | null> => "NOT THE ORIGINAL";
    const reverted = await runFinalStateGuard(state, base, writeRel(), lyingRead);

    expect(reverted).toBe(true);
    expect(state.finalStateReverted?.restoreVerified).toBe(false);
  });

  it("also deletes brand-new files the agent created when reverting", async () => {
    const base = await setupGreenRepo();
    // Agent both broke lib.ts AND created a new file; both are 'touched'.
    const state = {
      repoRoot: testDir,
      turns: [
        turnWith([
          { filePath: LIB_PATH, status: "applied", originalContent: GOOD_LIB, newContent: BROKEN_LIB },
          { filePath: NEW_BROKEN, status: "applied", newContent: "syntax ( error" }, // no originalContent → created
        ]),
      ],
    } as unknown as AgentState;
    await writeFile(join(testDir, LIB_PATH), BROKEN_LIB, "utf-8");
    await writeFile(join(testDir, NEW_BROKEN), "syntax ( error", "utf-8");

    const reverted = await runFinalStateGuard(state, base, writeRel());

    expect(reverted).toBe(true);
    expect(await exists(join(testDir, NEW_BROKEN))).toBe(false); // created file deleted
    expect(await readFile(join(testDir, LIB_PATH), "utf-8")).toBe(GOOD_LIB); // existing file restored
  });

  it("is a no-op when the end state is NOT worse than baseline (partial progress kept)", async () => {
    const base = await setupGreenRepo();
    const state = stateEditedLib();
    // Disk is still pristine/green — nothing regressed.
    const reverted = await runFinalStateGuard(state, base, writeRel());

    expect(reverted).toBe(false);
    expect(state.finalStateReverted).toBeUndefined();
    expect(await readFile(join(testDir, LIB_PATH), "utf-8")).toBe(GOOD_LIB);
  });

  it("is a no-op when the baseline had no tests (no signal to compare)", async () => {
    await setupGreenRepo();
    const noTests: TestBaseline = { failingIds: new Set(), hadAnyTests: false, redCount: 0, loadError: false };
    const state = stateEditedLib();
    await writeFile(join(testDir, LIB_PATH), BROKEN_LIB, "utf-8");

    const reverted = await runFinalStateGuard(state, noTests, writeRel());

    expect(reverted).toBe(false);
    // Left as-is: no baseline test signal means we cannot judge 'worse'.
    expect(await readFile(join(testDir, LIB_PATH), "utf-8")).toBe(BROKEN_LIB);
  });
});

// --- Eval-neutrality: a SOLVED run is never touched by the guard -------------

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

function makeContext(): ContextBundle {
  return { chunks: [], totalTokens: 0, tokenBudget: 4096, truncated: false, query: "fix the bug" };
}

describe("Lever 1 — final-state guard eval-neutrality through runLoop", () => {
  it("never reverts a SOLVED run even with the guard ON (verified → guard skipped)", async () => {
    process.env["SMALLCODE_FINAL_STATE_GUARD"] = "1";
    // Red baseline: lib.ts is broken; the model fixes it to green.
    testDir = join(tmpdir(), `smallcode-fsguard-solve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, "src"), { recursive: true });
    await mkdir(join(testDir, "tests"), { recursive: true });
    await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
    await writeFile(join(testDir, "src", "lib.ts"), BROKEN_LIB, "utf-8");
    await writeFile(
      join(testDir, "tests", "lib.test.ts"),
      'import { test, expect } from "bun:test";\nimport { answer } from "../src/lib.ts";\ntest("answer", () => { expect(answer).toBe(42); });\n',
      "utf-8",
    );

    const cfg: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 1, bestOfN: 1 };
    const state = createState(cfg, "Fix answer in src/lib.ts");
    state.goals = [{ id: "g1", description: "fix answer in src/lib.ts", status: "pending" }];
    const responses = [`FILE: ${LIB_PATH}\n\`\`\`ts\n${GOOD_LIB}\`\`\`\nTOOL: finish {"summary": "fixed"}`];
    const deps = {
      provider: makeSequentialProvider(responses),
      profile: makeProfile(),
      reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
      config: cfg,
    };

    const finalState = await runLoop(state, join(testDir, "state.json"), deps, async () => makeContext());

    expect(finalState.verified).toBe(true);
    expect(finalState.finalStateReverted).toBeUndefined(); // solved → guard never ran
    expect(await readFile(join(testDir, LIB_PATH), "utf-8")).toBe(GOOD_LIB); // fix left on disk
  });
});
