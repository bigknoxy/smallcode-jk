// Deterministic, no-model retrieval-correctness probe at the scale of smallcode's
// OWN src/ (~98 real, cross-importing TS files) — a regression guard for the
// lexical scorer. For a spread of unambiguous exported symbols, query = the bare
// symbol name, ground-truth = the file that DEFINES it; measure top-1 accuracy.
//
// (This started as an A/B of graph-centrality re-ranking vs lexical. Verdict:
// lexical was 40/40 (100%) on clean bare-name queries and centrality REGRESSED it
// to 31/40 by dragging the winner onto barrel index.ts re-export hubs. R3 graph
// retrieval refuted at scale; removed. Kept lexical-only as the regression guard —
// retrieval is a solved problem and this proves it stays solved.)
//
// Run: bun scripts/probe-retrieval-scale.ts
import { join, dirname } from "node:path";
import { walkRepo } from "../src/context/walker.ts";
import { scoreFiles } from "../src/context/scorer.ts";
import type { FileMap, RepoMap } from "../src/context/types.ts";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const TEST_FILE_RE = /\.test\.|\.spec\.|__tests__/;
const isTestFile = (p: string): boolean => TEST_FILE_RE.test(p);

async function main() {
  const repoMap: RepoMap = await walkRepo({ root: SRC_ROOT });

  // name -> defining files, function/class only.
  const nameToFiles = new Map<string, FileMap[]>();
  for (const file of repoMap.files) {
    for (const sym of file.symbols) {
      if (sym.kind !== "function" && sym.kind !== "class") continue;
      (nameToFiles.get(sym.name) ?? nameToFiles.set(sym.name, []).get(sym.name)!).push(file);
    }
  }

  // Unambiguous, non-test symbols, spread across top-level dirs.
  type Candidate = { symbolName: string; filePath: string; dir: string };
  const byDir = new Map<string, Candidate[]>();
  for (const [name, files] of nameToFiles) {
    if (files.length !== 1) continue;
    const filePath = files[0]!.path;
    if (isTestFile(filePath)) continue;
    const dir = filePath.includes("/") ? filePath.split("/")[0]! : "(root)";
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push({ symbolName: name, filePath, dir });
  }

  const TARGET_N = 40;
  const dirs = [...byDir.keys()].sort();
  const perDirCap = Math.max(2, Math.ceil(TARGET_N / Math.max(1, dirs.length)));
  const chosen: Candidate[] = [];
  for (const dir of dirs) {
    const arr = byDir.get(dir)!;
    const take = Math.min(perDirCap, arr.length);
    const step = Math.max(1, Math.floor(arr.length / take));
    for (let i = 0; i < arr.length && chosen.filter((c) => c.dir === dir).length < perDirCap; i += step) {
      chosen.push(arr[i]!);
    }
    if (chosen.length >= TARGET_N) break;
  }

  const nonTestFiles = repoMap.files.filter((f) => !isTestFile(f.path));
  let correct = 0;
  const misses: string[] = [];
  for (const c of chosen) {
    const top = scoreFiles(nonTestFiles, c.symbolName)[0]?.fileMap.path ?? "(none)";
    if (top === c.filePath) correct++;
    else misses.push(`  ✗ ${c.symbolName}: want ${c.filePath}, got ${top}`);
  }

  console.log(`Retrieval-correctness probe — smallcode src/ (${nonTestFiles.length} non-test files)`);
  console.log(`Bare-symbol-name queries, top-1 lexical: ${correct}/${chosen.length}`);
  if (misses.length) console.log(misses.join("\n"));
  console.log(
    correct === chosen.length
      ? "\nRetrieval is solved at repo scale (100%). Regression guard green."
      : "\nRegression: lexical retrieval dropped below 100% — inspect scorer.ts.",
  );
}

main();
