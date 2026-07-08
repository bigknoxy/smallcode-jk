import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, runOperatorMutationRepair, runStatementRepair } from "../src/agent/index.ts";
import type { AgentConfig, AgentState, TurnRecord } from "../src/agent/types.ts";
import { captureTestBaseline } from "../src/verify/oracle.ts";

// ---------------------------------------------------------------------------
// Dogfood #3 (2026-07-08) root cause: the last-resort repair passes call `bun
// test` per candidate, which can THROW (a timeout on a 613-file repo). An
// unguarded throw escaped runLoop — orphaning a half-tried candidate on disk AND
// skipping the final-state guard, leaving the repo worse than found.
//
// The fix wraps each repair's candidate loop in try/catch that restores the
// model's edit and returns null (UNSOLVED) instead of propagating — so runLoop
// reaches the final-state guard. These tests pin that contract deterministically
// via the injectable oracle seam (no global module mock): the oracle throws, the
// repair must NOT throw, must return null, and must leave the file exactly as the
// model left it (never a half-tried candidate).
// ---------------------------------------------------------------------------

// A comparison operator the mutation pass WOULD flip (so it reaches the throwing
// oracle rather than finding zero candidates and returning early).
const MODEL_EDIT = `export function eq(a, b) {
  return a !== b;
}
`;

const throwingOracle = (async () => {
  throw new Error("simulated bun test timeout");
}) as any;

let testDir: string;

async function setup(): Promise<{
  state: AgentState;
  readFileFn: (p: string) => Promise<string | null>;
  writeFileFn: (p: string, c: string) => Promise<void>;
}> {
  testDir = join(
    tmpdir(),
    `smallcode-repair-throw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(join(testDir, "tests"), { recursive: true });
  await writeFile(join(testDir, "package.json"), '{"name":"t","type":"module"}', "utf-8");
  // The model's on-disk edit (what the repair should preserve on a throw).
  await writeFile(join(testDir, "src", "eq.ts"), MODEL_EDIT, "utf-8");
  await writeFile(
    join(testDir, "tests", "eq.test.ts"),
    'import { test, expect } from "bun:test";\nimport { eq } from "../src/eq.ts";\ntest("eq", () => { expect(eq(2, 2)).toBe(true); });\n',
    "utf-8",
  );

  const config: AgentConfig = { repoRoot: testDir, modelId: "test-model", maxTurns: 2, bestOfN: 1 };
  const state = createState(config, "Fix eq");
  state.lockedTargetPath = "src/eq.ts";
  // A turn-history entry so the repair has a pristine base to also try (mirrors a
  // real run); its originalContent differs from the model's current edit.
  state.turns.push({
    turn: 1,
    goalId: "g1",
    prompt: "",
    rawResponse: "",
    answer: "",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [
      {
        filePath: "src/eq.ts",
        status: "applied",
        originalContent: "export function eq(a, b) {\n  return a === b;\n}\n",
        newContent: MODEL_EDIT,
      },
    ],
    promptTokens: 0,
    completionTokens: 0,
    timestamp: 0,
  } as TurnRecord);

  const readFileFn = async (p: string): Promise<string | null> => {
    try {
      return await readFile(join(testDir, p), "utf-8");
    } catch {
      return null;
    }
  };
  const writeFileFn = async (p: string, c: string): Promise<void> => {
    await writeFile(join(testDir, p), c, "utf-8");
  };
  return { state, readFileFn, writeFileFn };
}

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("repair passes contain a throwing oracle (dogfood #3 root cause)", () => {
  it("operator-mutation: an oracle throw returns null and restores the model's edit", async () => {
    const { state, readFileFn, writeFileFn } = await setup();
    const baseline = captureTestBaseline(testDir);

    let result: unknown;
    // Must NOT throw — the fix contains it.
    await expect(
      (async () => {
        result = await runOperatorMutationRepair(
          state,
          baseline,
          readFileFn,
          writeFileFn,
          throwingOracle,
        );
      })(),
    ).resolves.toBeUndefined();

    expect(result).toBeNull();
    // File left exactly as the model left it — no orphaned candidate on disk.
    const onDisk = await readFile(join(testDir, "src", "eq.ts"), "utf-8");
    expect(onDisk).toBe(MODEL_EDIT);
  });

  it("statement-repair: an oracle throw returns null and restores the model's edit", async () => {
    const { state, readFileFn, writeFileFn } = await setup();
    // Give the target a read-after-delete shape so statement-repair produces a
    // candidate and reaches the throwing oracle.
    const RAD =
      "export function f(m, k) {\n  m.delete(k);\n  m.set(k, m.get(k));\n  return m;\n}\n";
    await writeFile(join(testDir, "src", "eq.ts"), RAD, "utf-8");
    const baseline = captureTestBaseline(testDir);

    const result = await runStatementRepair(
      state,
      baseline,
      readFileFn,
      writeFileFn,
      throwingOracle,
    );

    expect(result).toBeNull();
    const onDisk = await readFile(join(testDir, "src", "eq.ts"), "utf-8");
    expect(onDisk).toBe(RAD);
  });
});
