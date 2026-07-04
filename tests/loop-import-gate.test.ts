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
// Lever 2 — static import-resolution gate through runLoop (SMALLCODE_IMPORT_GATE).
// The model emits a FILE: edit that imports a hallucinated module (`std/strings`,
// the dogfood failure). The gate reverts that file and feeds a targeted IMPORT
// ERROR naming the deps that DO exist, instead of letting the invented import
// survive to a full test run (R4's slower, vaguer signal).
// ---------------------------------------------------------------------------

const TARGET = "src/index.ts";
const GOOD = "export function f(x) { return x + 1; }\n"; // baseline (test expects f(1)===3, so this is red)
const HALLUCINATED = 'import { pad } from "std/strings";\nexport function f(x) { return pad(x + 2); }\n';

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

function makeProvider(responses: string[]): Provider {
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
  return {
    chunks: [{ filePath: TARGET, startLine: 1, endLine: 1, content: GOOD, estimatedTokens: 20, pinned: true }],
    totalTokens: 20,
    tokenBudget: 4096,
    truncated: false,
    query: "fix f in src/index.ts",
    targetFile: { path: TARGET, lineCount: 1, format: "full" },
  };
}

let testDir: string;
let priorGate: string | undefined;
let priorMut: string | undefined;

async function setupRepo(): Promise<void> {
  testDir = join(tmpdir(), `smallcode-importgate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module","dependencies":{"mri":"^1"}}', "utf-8");
  await writeFile(join(testDir, "src", "index.ts"), GOOD, "utf-8");
  // Red baseline (f(1) should be 3) → fix-mode, so the target lock pins src/index.ts.
  await writeFile(
    join(testDir, "tests", "index.test.ts"),
    'import { test, expect } from "bun:test";\nimport { f } from "../src/index.ts";\ntest("f", () => { expect(f(1)).toBe(3); });\n',
    "utf-8",
  );
}

function makeRun(responses: string[]) {
  const cfg: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 1, bestOfN: 1 };
  const state = createState(cfg, "Fix f in src/index.ts");
  state.goals = [{ id: "g1", description: "fix f in src/index.ts", status: "pending" }];
  return {
    state,
    deps: {
      provider: makeProvider(responses),
      profile: makeProfile(),
      reasoningHandler: new ReasoningHandler({ open: "<think>", close: "</think>" }),
      config: cfg,
    },
    statePath: join(testDir, "state.json"),
  };
}

beforeEach(() => {
  priorGate = process.env["SMALLCODE_IMPORT_GATE"];
  priorMut = process.env["SMALLCODE_MUTATION_REPAIR"];
  process.env["SMALLCODE_MUTATION_REPAIR"] = "0";
});

afterEach(async () => {
  if (priorGate === undefined) delete process.env["SMALLCODE_IMPORT_GATE"];
  else process.env["SMALLCODE_IMPORT_GATE"] = priorGate;
  if (priorMut === undefined) delete process.env["SMALLCODE_MUTATION_REPAIR"];
  else process.env["SMALLCODE_MUTATION_REPAIR"] = priorMut;
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

describe("Lever 2 — import gate through runLoop", () => {
  it("reverts a hallucinated import and feeds a targeted IMPORT ERROR when SMALLCODE_IMPORT_GATE=1", async () => {
    process.env["SMALLCODE_IMPORT_GATE"] = "1";
    await setupRepo();
    const { state, deps, statePath } = makeRun([
      `FILE: ${TARGET}\n\`\`\`ts\n${HALLUCINATED}\`\`\`\nTOOL: finish {"summary": "used std/strings"}`,
    ]);

    const finalState = await runLoop(state, statePath, deps, async () => makeContext());

    // The hallucinated edit was reverted off disk.
    expect(await readFile(join(testDir, TARGET), "utf-8")).toBe(GOOD);
    // The model got a crisp IMPORT ERROR naming the bad module and the real deps.
    const turn = finalState.turns.at(-1);
    const err = turn?.toolResults.find((t) => t.error?.includes("IMPORT ERROR"));
    expect(err).toBeDefined();
    expect(err?.error).toContain("std/strings");
    expect(err?.error).toContain("mri");
  });

  it("leaves the hallucinated import on disk when the gate is OFF (R4 handles it later)", async () => {
    delete process.env["SMALLCODE_IMPORT_GATE"];
    await setupRepo();
    const { state, deps, statePath } = makeRun([
      `FILE: ${TARGET}\n\`\`\`ts\n${HALLUCINATED}\`\`\`\nTOOL: finish {"summary": "used std/strings"}`,
    ]);

    const finalState = await runLoop(state, statePath, deps, async () => makeContext());

    const turn = finalState.turns.at(-1);
    expect(turn?.toolResults.some((t) => t.error?.includes("IMPORT ERROR"))).toBe(false);
  });

  it("does not fire on a valid relative import or a declared dep", async () => {
    process.env["SMALLCODE_IMPORT_GATE"] = "1";
    await setupRepo();
    // Edit imports the declared dep `mri` and a builtin — both resolve.
    const VALID = 'import mri from "mri";\nimport { join } from "node:path";\nexport function f(x) { return x + 2; }\n';
    const { state, deps, statePath } = makeRun([
      `FILE: ${TARGET}\n\`\`\`ts\n${VALID}\`\`\`\nTOOL: finish {"summary": "valid imports"}`,
    ]);

    const finalState = await runLoop(state, statePath, deps, async () => makeContext());

    const turn = finalState.turns.at(-1);
    expect(turn?.toolResults.some((t) => t.error?.includes("IMPORT ERROR"))).toBe(false);
    // The edit was NOT reverted by the gate (it stays as the model wrote it).
    expect(await readFile(join(testDir, TARGET), "utf-8")).toBe(VALID);
  });
});
