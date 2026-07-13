// Model-free localization-accuracy measuring stick.
// For every eval task with a fixture + solution overlay, walk the buggy fixture,
// run the REAL retrieval (buildContext → targetFile, the file the run LOCKS onto),
// and check whether it matches a ground-truth target (a file present in the
// task's solution overlay). Reports per-suite + overall accuracy. Deterministic,
// no model calls.
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { walkRepo } from "@/context/walker.ts";
import { buildContext } from "@/context/builder.ts";

const ROOT = ".";
const SUITES = ["realrepo", "edit-reliability", "multifile"];
const TOKEN_BUDGET = 28672; // matches the 7b run-config default

async function listFilesRel(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  }
  await walk(dir);
  return out.map((p) => relative(dir, p));
}

interface Row {
  id: string;
  suite: string;
  predicted: string | undefined;
  truth: string[];
  hit: boolean;
}

const rows: Row[] = [];

for (const suite of SUITES) {
  const suiteDir = join(ROOT, "evals/suites", suite);
  let taskFiles: string[];
  try {
    taskFiles = (await readdir(suiteDir)).filter((f) => f.endsWith(".json"));
  } catch {
    continue;
  }
  for (const tf of taskFiles) {
    const task = JSON.parse(await Bun.file(join(suiteDir, tf)).text());
    const fixture = task?.setup?.repoFixture;
    const solutionRel = task?.reference_solution;
    if (!fixture || !solutionRel) continue;
    const fixtureDir = join(ROOT, "evals/fixtures", fixture);
    const solutionDir = join(ROOT, "evals/fixtures", solutionRel.replace(/\/$/, ""));
    // Ground truth = source files in the solution overlay (they are the files
    // that must change). Exclude package.json / test files.
    const truth = (await listFilesRel(solutionDir)).filter(
      (p) => !p.endsWith("package.json") && !/(^|\/)tests?\//.test(p) && !p.endsWith(".test.ts"),
    );
    if (truth.length === 0) continue;

    let repoMap;
    try {
      repoMap = await walkRepo({ root: fixtureDir }, 0);
    } catch {
      continue;
    }
    const bundle = await buildContext(repoMap, task.desc, {
      repoRoot: fixtureDir,
      tokenBudget: TOKEN_BUDGET,
    });
    const predicted = bundle.targetFile?.path;
    const hit = predicted !== undefined && truth.includes(predicted);
    rows.push({ id: task.id, suite, predicted, truth, hit });
  }
}

// Report
const bySuite = new Map<string, Row[]>();
for (const r of rows) {
  if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
  bySuite.get(r.suite)!.push(r);
}

console.log("\n=== LOCALIZATION ACCURACY (target-file pick vs solution overlay) ===\n");
for (const [suite, rs] of bySuite) {
  const hits = rs.filter((r) => r.hit).length;
  console.log(`${suite}: ${hits}/${rs.length}  (${((hits / rs.length) * 100).toFixed(0)}%)`);
  for (const r of rs.filter((x) => !x.hit)) {
    console.log(`   MISS ${r.id}: picked=${r.predicted ?? "<none>"}  truth=[${r.truth.join(", ")}]`);
  }
}
const totalHits = rows.filter((r) => r.hit).length;
console.log(`\nOVERALL: ${totalHits}/${rows.length}  (${((totalHits / rows.length) * 100).toFixed(0)}%)`);
