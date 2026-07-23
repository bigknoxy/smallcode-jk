/**
 * Tests for two edit-reliability harness improvements:
 *
 *  GAP #1 — not-applied feedback matches the DIRECTED edit format. When a large
 *  target was given the SEARCH/REPLACE (minimal-diff) directive and the edit
 *  failed to apply, the recovery feedback must re-ask for SEARCH/REPLACE — NOT
 *  "re-emit the complete corrected file", which contradicts the directive and
 *  forces a whole-file → truncation → fail loop.
 *
 *  GAP #2 — revert-on-REGRESSION. An applied edit that flips previously-green
 *  tests to red is rolled back (revertFiles) and a ⚠ warning surfaces in Recent
 *  History. Reverting happens ONLY on a true regression (newFailures non-empty),
 *  never on a still-red suite with no new failures, never on solved.
 *
 * Plus three correctness fixes (adversarial review):
 *  FIX 1 — revert restores the EFFECTIVE (actually-written) path, not the emitted
 *          block path, so applyBatch's path-typo rescue can't leave the real file
 *          corrupted. applyBatch reports `effectivePath` + pre-batch
 *          `originalContent` per result.
 *  FIX 2 — a crash-regression (more red than baseline, NO parseable `(fail)`
 *          line) sets `verdict.regressed=true` with a synthetic newFailures entry,
 *          so the revert gate (`regressed===true`, not `newFailures.length`) fires.
 *  FIX 3 — on a reverted turn the failure signature folds back to the PRIOR turn's
 *          signature so consecutive regress→revert cycles advance the stall counter.
 *
 * GPU-free: no model/Ollama calls anywhere.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { applyBatch } from "../src/edit/index.ts";
import { buildTurnPrompt, revertFiles } from "../src/agent/index.ts";
import type { AgentState, TurnRecord } from "../src/agent/types.ts";
import type { ApplyResult, EditBlock } from "../src/edit/types.ts";
import type { ContextBundle, TargetFile } from "../src/context/types.ts";
import { captureTestBaseline, runTieredOracle } from "../src/verify/oracle.ts";

// DIFF_MIN_FN_LINES default (src/agent/prompt.ts). Functions >= this many lines
// are gated into SEARCH/REPLACE mode.
const DIFF_MIN_FN_LINES = Number(process.env["SMALLCODE_DIFF_MIN_FN"] ?? "30");

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    sessionId: "s",
    task: "fix the bug",
    repoRoot: "/tmp/test",
    modelId: "m",
    goals: [{ id: "g1", description: "fix it", status: "in_progress" }],
    currentGoalIndex: 0,
    turns: [],
    status: "running",
    scratchpad: "",
    startedAt: 0,
    updatedAt: 0,
    maxTurns: 10,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turn: 1,
    goalId: "g1",
    prompt: "p",
    rawResponse: "r",
    answer: "a",
    toolCalls: [],
    toolResults: [],
    editBlocks: [],
    applyResults: [],
    promptTokens: 0,
    completionTokens: 0,
    timestamp: 0,
    ...overrides,
  };
}

function notApplied(filePath: string): ApplyResult {
  return { filePath, status: "not_found", error: "search text not found" };
}

function ctx(targetFile: TargetFile | undefined, fileContent: string): ContextBundle {
  return {
    chunks: [
      {
        filePath: targetFile?.path ?? "src/x.ts",
        startLine: 1,
        endLine: 1,
        content: fileContent,
        estimatedTokens: 10,
        pinned: true,
      },
    ],
    totalTokens: 10,
    tokenBudget: 8192,
    truncated: false,
    query: "q",
    targetFile,
  };
}

// ---------------------------------------------------------------------------
// GAP #1 — not-applied feedback matches the directed edit format
// ---------------------------------------------------------------------------

describe("GAP#1 not-applied feedback matches the directive", () => {
  const FILE = "src/table.ts";
  const fileContent = "export function renderTable() {\n  return wrong;\n}\n";

  it("SR-mode target (patch + fn + large) → asks for SEARCH/REPLACE re-emit, NOT complete file", () => {
    const state = makeState();
    state.turns = [makeTurn({ applyResults: [notApplied(FILE)] })];
    const target: TargetFile = {
      path: FILE,
      lineCount: 200,
      format: "patch",
      functionName: "renderTable",
      functionLineCount: DIFF_MIN_FN_LINES + 5,
    };
    const prompt = buildTurnPrompt(state, ctx(target, fileContent));

    expect(prompt).toContain("Re-emit a SEARCH/REPLACE block for `renderTable`");
    expect(prompt).toContain("BYTE-FOR-BYTE");
    // Must NOT fall through to the whole-file fallback.
    expect(prompt).not.toContain("Re-emit the COMPLETE corrected file");
    // Must NOT use the PATCH fallback either.
    expect(prompt).not.toContain("Re-emit a PATCH block");
  });

  it("whole-file target (small / no functionName) → still says complete FILE: file", () => {
    const state = makeState();
    state.turns = [makeTurn({ applyResults: [notApplied(FILE)] })];
    // format full, no function => whole-file mode.
    const target: TargetFile = { path: FILE, lineCount: 12, format: "full" };
    const prompt = buildTurnPrompt(state, ctx(target, fileContent));

    expect(prompt).toContain("Re-emit the COMPLETE corrected file in a FILE: block.");
    expect(prompt).not.toContain("Re-emit a SEARCH/REPLACE block");
    expect(prompt).not.toContain("Re-emit a PATCH block");
  });

  it("small-function PATCH target (patch + fn but below DIFF_MIN_FN_LINES) → still says PATCH", () => {
    const state = makeState();
    state.turns = [makeTurn({ applyResults: [notApplied(FILE)] })];
    const target: TargetFile = {
      path: FILE,
      lineCount: 200,
      format: "patch",
      functionName: "renderTable",
      // BELOW the size gate → SR does not apply → PATCH retry.
      functionLineCount: DIFF_MIN_FN_LINES - 5,
    };
    const prompt = buildTurnPrompt(state, ctx(target, fileContent));

    expect(prompt).toContain("Re-emit a PATCH block for ONLY the `renderTable` function");
    expect(prompt).not.toContain("Re-emit a SEARCH/REPLACE block");
    expect(prompt).not.toContain("Re-emit the COMPLETE corrected file");
  });
});

// ---------------------------------------------------------------------------
// GAP #2 — revertFiles helper + the revert DECISION predicate
// ---------------------------------------------------------------------------

describe("GAP#2 revertFiles helper", () => {
  it("writes every captured original back via the write fn", async () => {
    const originals = new Map<string, string>([
      ["src/a.ts", "ORIGINAL A"],
      ["src/b.ts", "ORIGINAL B"],
    ]);
    const written = new Map<string, string>();
    await revertFiles(originals, async (p, content) => {
      written.set(p, content);
    });
    expect(written.get("src/a.ts")).toBe("ORIGINAL A");
    expect(written.get("src/b.ts")).toBe("ORIGINAL B");
    expect(written.size).toBe(2);
  });

  it("no-op for an empty originals map", async () => {
    let calls = 0;
    await revertFiles(new Map(), async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  // E1-T3: verified revert. When a readFileFn is supplied, the restore is PROVEN
  // by reading the bytes back, not assumed from the absence of a write throw.
  it("verified:true when every read-back matches the intended original", async () => {
    const originals = new Map<string, string>([["src/a.ts", "ORIGINAL A"], ["src/b.ts", "ORIGINAL B"]]);
    const disk = new Map<string, string>();
    const res = await revertFiles(
      originals,
      async (p, c) => void disk.set(p, c),
      async (p) => disk.get(p) ?? null,
    );
    expect(res.verified).toBe(true);
    expect(res.mismatched).toEqual([]);
  });

  it("verified:false + names the file when a write lands the WRONG bytes (partial/failed write)", async () => {
    const originals = new Map<string, string>([["src/a.ts", "ORIGINAL A"], ["src/b.ts", "ORIGINAL B"]]);
    const disk = new Map<string, string>();
    const res = await revertFiles(
      originals,
      // Simulate a partial write: src/b.ts silently ends up truncated on disk.
      async (p, c) => void disk.set(p, p === "src/b.ts" ? c.slice(0, 3) : c),
      async (p) => disk.get(p) ?? null,
    );
    expect(res.verified).toBe(false);
    expect(res.mismatched).toEqual(["src/b.ts"]);
  });

  it("verified:false when a restored file cannot be read back at all (write dropped)", async () => {
    const originals = new Map<string, string>([["src/a.ts", "ORIGINAL A"]]);
    const res = await revertFiles(
      originals,
      async () => {}, // write is a no-op — nothing lands on disk
      async () => null, // read-back finds nothing
    );
    expect(res.verified).toBe(false);
    expect(res.mismatched).toEqual(["src/a.ts"]);
  });

  it("fail-closed: verified:false when NO readFileFn is supplied (restore unproven)", async () => {
    const originals = new Map<string, string>([["src/a.ts", "ORIGINAL A"]]);
    const res = await revertFiles(originals, async () => {});
    expect(res.verified).toBe(false);
    expect(res.mismatched).toEqual([]);
  });
});

// Mirror of the loop's revert decision: revert iff a true regression occurred.
// (newFailures non-empty AND something applied; solved/clean/still-red do not.)
function shouldRevert(
  verdict: { newFailures?: string[] } | undefined,
  appliedAny: boolean,
  capturedAny: boolean,
): boolean {
  return Boolean(
    verdict?.newFailures && verdict.newFailures.length > 0 && capturedAny && appliedAny,
  );
}

describe("GAP#2 revert decision predicate", () => {
  it("newFailures non-empty ⇒ revert", () => {
    expect(shouldRevert({ newFailures: ["t1"] }, true, true)).toBe(true);
  });

  it("newFailures empty (still-red, model just hasn't fixed it) ⇒ NO revert", () => {
    expect(shouldRevert({ newFailures: [] }, true, true)).toBe(false);
  });

  it("solved (no newFailures field) ⇒ NO revert", () => {
    expect(shouldRevert({ newFailures: [] }, true, true)).toBe(false);
    expect(shouldRevert({}, true, true)).toBe(false);
  });

  it("regression but nothing applied ⇒ NO revert", () => {
    expect(shouldRevert({ newFailures: ["t1"] }, false, true)).toBe(false);
  });

  it("regression but nothing captured ⇒ NO revert", () => {
    expect(shouldRevert({ newFailures: ["t1"] }, true, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GAP #2 — revert warning surfaces in Recent History
// ---------------------------------------------------------------------------

describe("GAP#2 revert warning in Recent History", () => {
  it("emits the ⚠ revert warning with the newFailures list", () => {
    const state = makeState();
    state.turns = [
      makeTurn({
        turn: 1,
        applyResults: [{ filePath: "src/a.ts", status: "applied" }],
        reverted: { newFailures: ["foo > bar", "baz > qux"] },
      }),
    ];
    const prompt = buildTurnPrompt(state, {
      chunks: [],
      totalTokens: 0,
      tokenBudget: 8192,
      truncated: false,
      query: "q",
    });

    expect(prompt).toContain("Your edit was REVERTED");
    expect(prompt).toContain("foo > bar");
    expect(prompt).toContain("baz > qux");
    expect(prompt).toContain("Re-edit and change ONLY the target function/line");
  });

  it("does NOT emit the revert warning when the turn was not reverted", () => {
    const state = makeState();
    state.turns = [makeTurn({ turn: 1, applyResults: [{ filePath: "src/a.ts", status: "applied" }] })];
    const prompt = buildTurnPrompt(state, {
      chunks: [],
      totalTokens: 0,
      tokenBudget: 8192,
      truncated: false,
      query: "q",
    });
    expect(prompt).not.toContain("Your edit was REVERTED");
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — revert restores the EFFECTIVE (actually-written) path
// ---------------------------------------------------------------------------

// Mirror of the loop's revert-set construction (loop.ts): build effectivePath →
// pre-batch originalContent from the applied results, skipping brand-new files.
function buildRevertSet(results: ApplyResult[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of results) {
    if (r.status !== "applied") continue;
    if (r.originalContent === undefined) continue;
    const key = r.effectivePath ?? r.filePath;
    if (!out.has(key)) out.set(key, r.originalContent);
  }
  return out;
}

function full(filePath: string, replace: string): EditBlock {
  return { filePath, search: "", replace, format: "full-file" };
}

describe("FIX1 revert targets the EFFECTIVE path under path-typo rescue", () => {
  it("applyBatch reports effectivePath + pre-batch originalContent; revert hits the REAL file", async () => {
    // Disk has the real file `src/stats.ts`; the model emits the flattened typo
    // `src.stats.ts`. applyBatch's rescue redirects the write to the real file.
    const disk = new Map<string, string>([["src/stats.ts", "export const x = 1;\n"]]);
    const readFile = async (p: string): Promise<string | null> =>
      disk.has(p) ? (disk.get(p) ?? null) : null;
    const writeFile = async (p: string, c: string): Promise<void> => {
      disk.set(p, c);
    };

    const next = "export const x = 999; // corrupted\n";
    const batch = await applyBatch([full("src.stats.ts", next)], readFile, writeFile);
    const r = batch.results[0]!;

    // The result carries the EFFECTIVE path (real file), not the emitted typo,
    // and the pre-batch original content.
    expect(r.status).toBe("applied");
    expect(r.effectivePath).toBe("src/stats.ts");
    expect(r.originalContent).toBe("export const x = 1;\n");
    // Edit landed on the real file.
    expect(disk.get("src/stats.ts")).toBe(next);

    // Now revert. The revert set is keyed by effectivePath → the ORIGINAL is
    // restored to the REAL file, not written to the typo path.
    const revertSet = buildRevertSet(batch.results);
    expect([...revertSet.keys()]).toEqual(["src/stats.ts"]);
    const reverted = new Map<string, string>();
    await revertFiles(revertSet, async (p, c) => {
      reverted.set(p, c);
      disk.set(p, c);
    });
    expect(reverted.get("src/stats.ts")).toBe("export const x = 1;\n");
    // The typo path was never written.
    expect(reverted.has("src.stats.ts")).toBe(false);
    expect(disk.has("src.stats.ts")).toBe(false);
    // Real file fully restored.
    expect(disk.get("src/stats.ts")).toBe("export const x = 1;\n");
  });

  it("multi-block same-file → originalContent is the PRE-BATCH content (full undo)", async () => {
    // Two search/replace blocks edit the same file in one batch. The revert
    // original for that file must be the content BEFORE the first block, so a
    // revert undoes BOTH edits — not the intermediate state after block 1.
    const ORIGINAL = "const a = 1;\nconst b = 2;\n";
    const disk = new Map<string, string>([["src/m.ts", ORIGINAL]]);
    const readFile = async (p: string): Promise<string | null> =>
      disk.has(p) ? (disk.get(p) ?? null) : null;
    const writeFile = async (p: string, c: string): Promise<void> => {
      disk.set(p, c);
    };

    const blocks: EditBlock[] = [
      { filePath: "src/m.ts", search: "const a = 1;", replace: "const a = 10;", format: "search-replace" },
      { filePath: "src/m.ts", search: "const b = 2;", replace: "const b = 20;", format: "search-replace" },
    ];
    const batch = await applyBatch(blocks, readFile, writeFile);
    expect(batch.allApplied).toBe(true);
    // Disk now has BOTH edits applied.
    expect(disk.get("src/m.ts")).toBe("const a = 10;\nconst b = 20;\n");

    // Every applied result for the file reports the SAME pre-batch original.
    for (const r of batch.results) {
      expect(r.originalContent).toBe(ORIGINAL);
    }

    // Revert restores the pre-batch content (undoes both edits).
    const revertSet = buildRevertSet(batch.results);
    expect(revertSet.get("src/m.ts")).toBe(ORIGINAL);
    await revertFiles(revertSet, async (p, c) => {
      disk.set(p, c);
    });
    expect(disk.get("src/m.ts")).toBe(ORIGINAL);
  });

  it("brand-new file (no prior content) → originalContent undefined → skipped by revert", async () => {
    const disk = new Map<string, string>();
    const readFile = async (p: string): Promise<string | null> =>
      disk.has(p) ? (disk.get(p) ?? null) : null;
    const writeFile = async (p: string, c: string): Promise<void> => {
      disk.set(p, c);
    };

    const batch = await applyBatch([full("src/new.ts", "export const y = 1;\n")], readFile, writeFile);
    const r = batch.results[0]!;
    expect(r.status).toBe("applied");
    expect(r.effectivePath).toBe("src/new.ts");
    expect(r.originalContent).toBeUndefined();

    // New file is NOT in the revert set (nothing to restore to → left in place).
    expect(buildRevertSet(batch.results).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — crash-regression sets regressed=true with a synthetic newFailures entry
// ---------------------------------------------------------------------------

// Mirror of the loop's revert gate (loop.ts): revert iff regressed===true AND
// the revert set is non-empty.
function revertGate(verdict: { regressed?: boolean } | undefined, revertSetSize: number): boolean {
  return verdict?.regressed === true && revertSetSize > 0;
}

describe("FIX2 regressed flag + synthetic newFailures (real oracle, no model)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function scaffold(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fix2-"));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }
    return dir;
  }

  it("crash-regression (no parseable (fail) line) ⇒ regressed:true, synthetic entry, revert fires", async () => {
    // Baseline green: one passing test.
    const dir = await scaffold({
      "src/m.ts": "export const add = (a: number, b: number) => a + b;\n",
      "tests/ok.test.ts":
        'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("ok", () => expect(add(2, 3)).toBe(5));\n',
      "package.json": '{"name":"t","type":"module"}',
    });
    const baseline = captureTestBaseline(dir);
    expect(baseline.redCount).toBe(0);

    // "Edit" crashes a module: import of a missing file → bun reports an `error`
    // in the summary with NO `(fail) <name>` line. The id-parser sees nothing.
    await writeFile(
      join(dir, "tests", "crash.test.ts"),
      'import { nope } from "../src/does-not-exist.ts";\nimport { test } from "bun:test";\ntest("never", () => nope());\n',
      "utf-8",
    );

    const verdict = await runTieredOracle(dir, { baseline });
    expect(verdict.outcome).toBe("failing");
    // No parseable new (fail) line, yet regressed is TRUE. This crash is a missing
    // import → R4 classifies it as an introduced load error (a hard regression even
    // though the red-count did not rise), surfacing the build-error entry.
    expect(verdict.regressed).toBe(true);
    // A synthetic informative entry is surfaced for the model + revert warning.
    expect(
      verdict.newFailures?.some((f) => f.includes("build error") || f.includes("unparseable failure")),
    ).toBe(true);
    // The loop's revert gate fires (assuming an applied edit captured an original).
    expect(revertGate(verdict, 1)).toBe(true);
  }, 60_000);

  it("still-red with NO regression (pre-existing fail, no change) ⇒ regressed falsy, NO revert", async () => {
    const dir = await scaffold({
      "src/m.ts": "export const add = (a: number, b: number) => a - b;\n",
      "tests/red.test.ts":
        'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("add works", () => expect(add(2, 3)).toBe(5));\n',
      "package.json": '{"name":"t","type":"module"}',
    });
    const baseline = captureTestBaseline(dir);
    // Re-run with nothing changed: same single failure, no count regression.
    const verdict = await runTieredOracle(dir, { baseline });
    expect(verdict.outcome).toBe("failing");
    expect(verdict.regressed).toBeFalsy();
    expect(verdict.newFailures).toHaveLength(0);
    // Revert gate does NOT fire → model keeps iterating on its progress.
    expect(revertGate(verdict, 1)).toBe(false);
  }, 60_000);

  it("solved ⇒ regressed undefined ⇒ no revert", async () => {
    const dir = await scaffold({
      "src/m.ts": "export const add = (a: number, b: number) => a + b;\n",
      "tests/ok.test.ts":
        'import { test, expect } from "bun:test";\nimport { add } from "../src/m.ts";\ntest("ok", () => expect(add(2, 3)).toBe(5));\n',
      "package.json": '{"name":"t","type":"module"}',
    });
    const baseline = captureTestBaseline(dir);
    const verdict = await runTieredOracle(dir, { baseline });
    expect(verdict.outcome).toBe("solved");
    expect(verdict.regressed).toBeUndefined();
    expect(revertGate(verdict, 1)).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// FIX 3 — reverted turn folds its signature onto the PRIOR one so the stall
// counter advances across consecutive regress→revert cycles
// ---------------------------------------------------------------------------

// Mirror of the loop's signature selection (loop.ts): on a reverted turn, when a
// prior failure signature exists, reuse it; otherwise keep this turn's computed
// (stable) signature. Returns the effective turnFailureSig.
function effectiveSig(args: {
  computedSig: string;
  reverted: boolean;
  priorSig: string | undefined;
}): string {
  if (args.reverted && args.priorSig !== undefined) return args.priorSig;
  return args.computedSig;
}

describe("FIX3 reverted turns keep a stable stall signature", () => {
  it("two consecutive reverted turns produce the SAME signature ⇒ stall counter advances", () => {
    // Turn A: first failing+reverted turn. No prior signature yet. The computed
    // signature (stable for an identical regression) is kept and becomes the
    // prior signature for the next turn.
    const sigA = effectiveSig({ computedSig: "feedback:regress-X", reverted: true, priorSig: undefined });

    // Turn B: another reverted turn — the post-edit verdict could compute a
    // DIFFERENT transient signature, but because a prior signature now exists it
    // folds back onto it, so B === A and the stall counter sees a repeat.
    const sigB = effectiveSig({ computedSig: "feedback:regress-Y-transient", reverted: true, priorSig: sigA });

    expect(sigB).toBe(sigA);
    // Simulate the loop's stall comparison: equal signatures ⇒ counter increments.
    expect(sigB === sigA).toBe(true);
  });

  it("normal (non-reverted) failing turn is UNCHANGED — uses its own computed signature", () => {
    const sig = effectiveSig({
      computedSig: "feedback:real-failure",
      reverted: false,
      priorSig: "feedback:something-else",
    });
    expect(sig).toBe("feedback:real-failure");
  });
});
