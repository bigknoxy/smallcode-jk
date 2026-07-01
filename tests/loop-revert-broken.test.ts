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
// Regression test for the "never leave the repo broken" guarantee.
//
// Root cause (found via forensic-not-guess reproduction): the loop's revert
// set (loop.ts ~line 518) was built ONLY from `applyResults` — the output of
// applyBatch, which handles FILE:/PATCH: edit blocks. The `write_file` TOOL
// call (tools.ts) writes straight to disk via `Bun.write` and is executed
// separately (loop.ts ~line 457), never touching applyBatch, so its pre-write
// content was never captured anywhere. A build-breaking `write_file` edit
// therefore correctly flipped `verdict.regressed` to true (the oracle DOES
// see the broken build) but `revertOriginals` stayed empty for that file, so
// the revert gate (`revertOriginals.size > 0`) never fired and the garbage
// content was left on disk indefinitely — exactly the live dogfood failure
// (src/cli/args.ts left non-parseable for 5 turns to max_turns).
//
// Fix: loop.ts now snapshots each `write_file` call's pre-turn content (the
// same "first on-disk version wins" semantics applyBatch already uses) BEFORE
// executing it, and folds those snapshots into `revertOriginals` alongside
// the applyBatch-derived ones — so a regression is rolled back regardless of
// which write path (edit block or write_file tool) produced it.
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
  return { chunks: [], totalTokens: 0, tokenBudget: 2048, truncated: false, query: "test goal" };
}

let testDir: string;
const VALID_SOURCE = "export function s(x: string): string {\n  return x;\n}\n";
const GARBAGE_SOURCE = "export function s(x: string): string {\n  return x -;\n}\n"; // balanced braces, bad token

beforeEach(async () => {
  testDir = join(tmpdir(), `smallcode-revert-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
  await writeFile(join(testDir, "src", "m.ts"), VALID_SOURCE, "utf-8");
  await writeFile(
    join(testDir, "tests", "m.test.ts"),
    'import { test, expect } from "bun:test";\nimport { s } from "../src/m.ts";\ntest("a", () => expect(s("x")).toBe("x"));\n',
    "utf-8",
  );
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function runOneTurn(answer: string): Promise<void> {
  const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 1, bestOfN: 1 };
  const state = createState(config, "break the file");
  state.goals = [{ id: "goal-1", description: "edit m.ts", status: "pending" }];

  const provider = makeProvider(answer);
  const profile = makeProfile();
  const reasoningHandler = new ReasoningHandler({ open: "<think>", close: "</think>" });
  const statePath = join(testDir, "state.json");

  await runLoop(
    state,
    statePath,
    { provider, profile, reasoningHandler, config },
    async (_goal) => makeContext(),
  );
}

describe("revert-on-regression guarantee", () => {
  it("reverts a build-breaking edit delivered via a FILE: edit block", async () => {
    const answer = `FILE: src/m.ts\n\`\`\`ts\n${GARBAGE_SOURCE}\`\`\`\nTOOL: finish {"summary": "done"}`;
    await runOneTurn(answer);

    const content = await readFile(join(testDir, "src", "m.ts"), "utf-8");
    expect(content).toBe(VALID_SOURCE);
  });

  it("reverts a build-breaking edit delivered via the write_file TOOL call (the dogfood bug)", async () => {
    const answer = `TOOL: write_file {"path": "src/m.ts", "content": ${JSON.stringify(GARBAGE_SOURCE)}}\nTOOL: finish {"summary": "done"}`;
    await runOneTurn(answer);

    const content = await readFile(join(testDir, "src", "m.ts"), "utf-8");
    expect(content).toBe(VALID_SOURCE);
  });
});
