/**
 * Tests for Option A: the harness pins the target source file as an undroppable
 * whole chunk and deterministically size-gates the edit format (whole-file FILE:
 * vs single-function PATCH:). Covers builder target selection + buildTurnPrompt
 * directive emission.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTurnPrompt } from "../src/agent/prompt.ts";
import type { AgentState } from "../src/agent/types.ts";
import { buildContext } from "../src/context/builder.ts";
import { PATCH_LINE_THRESHOLD } from "../src/edit/patch-function.ts";
import type { CodeSymbol, ContextBundle, FileMap, RepoMap } from "../src/context/types.ts";

function sym(name: string, line = 1, endLine = 10): CodeSymbol {
  return { name, kind: "function", line, endLine };
}

function file(path: string, symbols: CodeSymbol[], lineCount: number): FileMap {
  return { path, language: "typescript", symbols, lineCount, sizeBytes: lineCount * 30 };
}

function repoMap(root: string, files: FileMap[]): RepoMap {
  return { root, files, totalSymbols: files.reduce((n, f) => n + f.symbols.length, 0), builtAt: 0 };
}

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "edit-target-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return root;
}

describe("buildContext target pinning + format gating", () => {
  it("picks the source file (not the test) as the pinned target, format=full for a small file", async () => {
    const src = "export function toKebab(s: string): string {\n  return s;\n}\n";
    const testSrc = "import { toKebab } from '../src/casing';\n// toKebab tests\n";
    const root = await makeRepo({ "src/casing.ts": src, "tests/casing.test.ts": testSrc });
    try {
      const rm0 = repoMap(root, [
        file("src/casing.ts", [sym("toKebab")], 3),
        file("tests/casing.test.ts", [sym("toKebab")], 2),
      ]);
      const bundle = await buildContext(rm0, "fix toKebab in casing", {
        repoRoot: root,
        tokenBudget: 8192,
      });

      expect(bundle.targetFile?.path).toBe("src/casing.ts");
      expect(bundle.targetFile?.format).toBe("full");
      expect(bundle.targetFile?.functionName).toBe("toKebab");
      const pinned = bundle.chunks.filter((c) => c.pinned);
      expect(pinned).toHaveLength(1);
      expect(pinned[0]?.filePath).toBe("src/casing.ts");
      expect(pinned[0]?.content).toBe(src); // WHOLE file, not a window
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gates a large file to format=patch", async () => {
    const big = `export function renderTable() {\n${"  const x = 1;\n".repeat(PATCH_LINE_THRESHOLD + 20)}}\n`;
    const root = await makeRepo({ "src/table.ts": big });
    try {
      const rm0 = repoMap(root, [
        file("src/table.ts", [sym("renderTable")], PATCH_LINE_THRESHOLD + 22),
      ]);
      const bundle = await buildContext(rm0, "fix renderTable in table", {
        repoRoot: root,
        tokenBudget: 100_000,
      });
      expect(bundle.targetFile?.format).toBe("patch");
      expect(bundle.targetFile?.functionName).toBe("renderTable");
      // Even a large target is pinned and whole.
      expect(bundle.chunks.find((c) => c.pinned)?.content).toBe(big);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins the WHOLE target even when the budget is tiny (never windowed)", async () => {
    const src = `export function wrapText() {\n${"  line();\n".repeat(60)}}\n`;
    const root = await makeRepo({ "src/wrap.ts": src });
    try {
      const rm0 = repoMap(root, [file("src/wrap.ts", [sym("wrapText")], 62)]);
      const bundle = await buildContext(rm0, "fix wrapText in wrap", {
        repoRoot: root,
        tokenBudget: 2048,
        reserveTokens: 2040, // ~8 tokens effective budget
      });
      // The pinned target is present in full despite the budget being ~0.
      const pinned = bundle.chunks.find((c) => c.pinned);
      expect(pinned?.content).toBe(src);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips a barrel/re-export index file in favor of the file that defines the symbol", async () => {
    const barrel =
      'export { toKebab } from "./casing.ts";\nexport {\n  padCell,\n  renderTable,\n} from "./table.ts";\n';
    const table = `export function padCell() {\n${"  const x = 1;\n".repeat(40)}}\n`;
    const root = await makeRepo({ "src/index.ts": barrel, "src/table.ts": table });
    try {
      const rm0 = repoMap(root, [
        // The barrel lists every re-exported name as a symbol — it out-scores the
        // real file unless skipped.
        file("src/index.ts", [sym("toKebab"), sym("padCell"), sym("renderTable")], 5),
        file("src/table.ts", [sym("padCell")], 42),
      ]);
      const bundle = await buildContext(rm0, "fix padCell in renderTable", {
        repoRoot: root,
        tokenBudget: 8192,
      });
      expect(bundle.targetFile?.path).toBe("src/table.ts");
      expect(bundle.chunks.find((c) => c.pinned)?.filePath).toBe("src/table.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("picks the exactly-matching function over a weak substring match", async () => {
    // Query token "to" (len 2) substring-matches `tokenize`; exact token
    // "tokebab" must win for the PATCH target.
    const src = `export function tokenize() {}\nexport function toKebab() {\n${"  x();\n".repeat(150)}}\n`;
    const root = await makeRepo({ "src/casing.ts": src });
    try {
      const rm0 = repoMap(root, [file("src/casing.ts", [sym("tokenize"), sym("toKebab")], 153)]);
      const bundle = await buildContext(rm0, "fix toKebab to join with hyphen", {
        repoRoot: root,
        tokenBudget: 100_000,
      });
      expect(bundle.targetFile?.functionName).toBe("toKebab");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("baseline mode (pinTarget=false) sets no target and pins nothing", async () => {
    const root = await makeRepo({ "src/casing.ts": "export function toKebab() { return ''; }\n" });
    try {
      const rm0 = repoMap(root, [file("src/casing.ts", [sym("toKebab")], 1)]);
      const bundle = await buildContext(rm0, "fix toKebab", {
        repoRoot: root,
        tokenBudget: 8192,
        pinTarget: false,
      });
      expect(bundle.targetFile).toBeUndefined();
      expect(bundle.chunks.some((c) => c.pinned)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no target when nothing lexically matches the query", async () => {
    const root = await makeRepo({ "src/casing.ts": "export const x = 1;\n" });
    try {
      const rm0 = repoMap(root, [file("src/casing.ts", [sym("toKebab")], 1)]);
      const bundle = await buildContext(rm0, "zzz qqq nomatch", {
        repoRoot: root,
        tokenBudget: 8192,
      });
      expect(bundle.targetFile).toBeUndefined();
      expect(bundle.chunks.some((c) => c.pinned)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function makeState(): AgentState {
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
  };
}

function ctxWithTarget(targetFile: ContextBundle["targetFile"]): ContextBundle {
  return { chunks: [], totalTokens: 0, tokenBudget: 8192, truncated: false, query: "q", targetFile };
}

describe("buildTurnPrompt edit-format directive", () => {
  it("emits a PATCH directive for a large target with a known function", () => {
    const prompt = buildTurnPrompt(
      makeState(),
      ctxWithTarget({ path: "src/table.ts", lineCount: 164, format: "patch", functionName: "padCell" }),
    );
    expect(prompt).toContain("## Edit Target — src/table.ts (164 lines)");
    expect(prompt).toContain("PATCH: src/table.ts");
    expect(prompt).toContain("FUNCTION: padCell");
    expect(prompt).toContain("Do NOT emit the whole file");
  });

  it("emits a whole-file FILE directive for a small target", () => {
    const prompt = buildTurnPrompt(
      makeState(),
      ctxWithTarget({ path: "src/casing.ts", lineCount: 29, format: "full", functionName: "toKebab" }),
    );
    expect(prompt).toContain("## Edit Target — src/casing.ts (29 lines)");
    expect(prompt).toContain("Emit the COMPLETE file");
    expect(prompt).not.toContain("PATCH: src/casing.ts");
  });

  it("falls back to whole-file when format=patch but no function name is known", () => {
    const prompt = buildTurnPrompt(
      makeState(),
      ctxWithTarget({ path: "src/big.ts", lineCount: 200, format: "patch" }),
    );
    expect(prompt).toContain("Emit the COMPLETE file");
    expect(prompt).not.toContain("PATCH: src/big.ts");
  });

  it("emits no Edit Target section when there is no target", () => {
    const prompt = buildTurnPrompt(makeState(), ctxWithTarget(undefined));
    expect(prompt).not.toContain("## Edit Target");
  });
});
