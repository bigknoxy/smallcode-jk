#!/usr/bin/env bun
/**
 * GPU-free pre-check for the minimal-DIFF (SEARCH/REPLACE) edit format.
 *
 * For each real-repo fixture, hand-build the IDEAL SEARCH/REPLACE block (the exact
 * buggy lines from the fixture -> the exact fixed lines from the solution), push it
 * through the live parse() + applyBatch() pipeline against a copy of the buggy repo,
 * then run the real `bun test` oracle. If the existing parser/applier/repair cannot
 * land a hand-perfect diff, the format is dead before spending any GPU.
 */
import { cp, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parse, applyBatch } from "../src/edit/index.ts";

const ROOT = "/Users/Joshua.Knox/projects/smallcode-claude";

interface Case {
  id: string;
  file: string;
  bug: [number, number]; // 1-based inclusive line range in the buggy file
  fix: [number, number]; // 1-based inclusive line range in the solution file
}

const CASES: Case[] = [
  { id: "realrepo-mri-flags_1", file: "src/index.js", bug: [90, 90], fix: [90, 90] },
  { id: "realrepo-dequal-multifile_1", file: "src/index.js", bug: [18, 19], fix: [18, 20] },
  { id: "realrepo-klona-array_1", file: "src/index.js", bug: [34, 34], fix: [34, 34] },
];

function slice(text: string, [a, b]: [number, number]): string {
  return text.split("\n").slice(a - 1, b).join("\n");
}

let allGreen = true;

for (const c of CASES) {
  const fixDir = join(ROOT, "evals/fixtures", c.id);
  const solDir = join(ROOT, "evals/fixtures", `${c.id}-solution`);
  const buggy = await readFile(join(fixDir, c.file), "utf-8");
  const sol = await readFile(join(solDir, c.file), "utf-8");

  const search = slice(buggy, c.bug);
  const replace = slice(sol, c.fix);
  const block = `${c.file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

  // 1. Parse
  const parsed = parse(block);
  const parseOk = parsed.blocks.length === 1 && parsed.errors.length === 0;

  // 2. Apply against a fresh copy of the buggy repo
  const trial = await mkdtemp(join(tmpdir(), "diff-precheck-"));
  await cp(fixDir, trial, { recursive: true });
  const rf = async (p: string): Promise<string | null> => {
    try {
      return await readFile(join(trial, p), "utf-8");
    } catch {
      return null;
    }
  };
  const wf = async (p: string, content: string): Promise<void> => {
    await mkdir(dirname(join(trial, p)), { recursive: true });
    await writeFile(join(trial, p), content, "utf-8");
  };
  const applied = await applyBatch(parsed.blocks, rf, wf);
  const applyOk = applied.results.every((r) => r.status === "applied");

  // 3. Run the real bun:test oracle
  const proc = Bun.spawnSync(["bun", "test"], { cwd: trial, stdout: "pipe", stderr: "pipe" });
  const oracleOk = proc.exitCode === 0;

  const verdict = parseOk && applyOk && oracleOk ? "✅ GREEN" : "❌ FAIL";
  if (!(parseOk && applyOk && oracleOk)) allGreen = false;
  console.log(
    `${verdict}  ${c.id.padEnd(28)} parse=${parseOk} apply=${applyOk}(${applied.results.map((r) => r.status).join(",")}) oracle=${oracleOk}`,
  );
  if (!oracleOk) {
    const err = proc.stderr.toString().slice(-300);
    console.log(`   oracle stderr tail: ${err.replace(/\n/g, " ")}`);
  }
}

console.log(`\n${allGreen ? "ALL GREEN — minimal-diff format is viable; proceed to GPU falsification." : "NOT all green — investigate before building."}`);
process.exit(allGreen ? 0 : 1);
