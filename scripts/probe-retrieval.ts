#!/usr/bin/env bun
// R3 retrieval probe: for every multi-file fixture, build context for the task
// query and check whether the PINNED target file matches the file the reference
// solution actually edits. Pure + deterministic (no model). Toggle the graph with
// SMALLCODE_REPO_GRAPH=1 and compare the two runs.
//
//   bun scripts/probe-retrieval.ts                 # lexical only
//   SMALLCODE_REPO_GRAPH=1 bun scripts/probe-retrieval.ts   # + graph centrality
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { walkRepo, buildContext } from "../src/context/index.ts";

const ROOT = import.meta.dir + "/..";
const FIX = join(ROOT, "evals/fixtures");

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function srcFileCount(dir: string): Promise<number> {
  const src = join(dir, "src");
  if (!(await isDir(src))) return 0;
  let n = 0;
  for (const e of await readdir(src, { withFileTypes: true, recursive: true } as any)) {
    if (e.isFile?.()) n++;
  }
  return n;
}

// The file the solution overlay edits = the correct retrieval target.
async function solutionTarget(id: string): Promise<string | null> {
  const sol = join(FIX, `${id}-solution`, "src");
  if (!(await isDir(sol))) return null;
  const files: string[] = [];
  async function walk(d: string, rel: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), r);
      else files.push(`src/${r}`);
    }
  }
  await walk(sol, "");
  return files[0] ?? null; // sparse overlays edit one file
}

const graphOn = process.env.SMALLCODE_REPO_GRAPH === "1";
console.log(`[probe] REPO_GRAPH=${graphOn ? "ON" : "off"}`);

const entries = await readdir(FIX, { withFileTypes: true });
let multi = 0;
let correct = 0;
const rows: string[] = [];

for (const e of entries) {
  if (!e.isDirectory() || e.name.endsWith("-solution")) continue;
  const dir = join(FIX, e.name);
  if ((await srcFileCount(dir)) < 2) continue; // multi-file only

  // Find the task desc (search all suites for this id).
  let desc = "";
  for (const s of await readdir(join(ROOT, "evals/suites"))) {
    const p = join(ROOT, "evals/suites", s, `${e.name}.json`);
    try {
      desc = JSON.parse(await readFile(p, "utf-8")).desc ?? "";
      break;
    } catch {}
  }
  if (!desc) continue;
  const want = await solutionTarget(e.name);
  if (!want) continue;

  multi++;
  const repoMap = await walkRepo({ root: dir }, Date.now());
  const bundle = await buildContext(repoMap, desc, { repoRoot: dir, tokenBudget: 8000 });
  const got = bundle.targetFile?.path ?? "(none)";
  const ok = got === want;
  if (ok) correct++;
  rows.push(`  ${ok ? "✓" : "✗"} ${e.name.padEnd(40)} want=${want} got=${got}`);
}

console.log(rows.join("\n"));
console.log(`\n[probe] target-correct: ${correct}/${multi} multi-file fixtures`);
