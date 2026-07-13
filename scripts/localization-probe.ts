// Model-free real-repo localization probe.
//
// For each concept-framed case in a probe file, walk smallcode's OWN repo and
// check whether the retrieval target-file pick (buildContext.targetFile — the
// file a `smallcode run` LOCKS onto) and the top-3 ranked candidates hit a
// ground-truth definer file. This is the measuring stick for the "defines over
// uses" scorer signal: the synthetic eval fixtures name the target path in their
// task text (PATH_MENTION dominates → localization trivially 100%), so they are
// BLIND to the real-repo condition where a task names a mechanism, not a path.
//
// Usage:
//   bun scripts/localization-probe.ts [probe.json]
// Default probe = evals/localization/independent-probe.json (the honest headline
// set, authored blind to the ranking code). Pass real-repo-probe.json for the
// filename-word-present variant.
import { walkRepo } from "@/context/walker.ts";
import { buildContext } from "@/context/builder.ts";
import { scoreFiles } from "@/context/scorer.ts";
import { isTestFilePath } from "@/edit/applier.ts";

const ROOT = ".";
const TOKEN_BUDGET = 28672; // matches the 7b run-config default

const probePath = process.argv[2] ?? "evals/localization/independent-probe.json";
const probe = JSON.parse(await Bun.file(probePath).text());
const repoMap = await walkRepo({ root: ROOT }, 0);

let top1 = 0;
let top3 = 0;
const misses: string[] = [];

for (const c of probe.cases) {
  const bundle = await buildContext(repoMap, c.query, { repoRoot: ROOT, tokenBudget: TOKEN_BUDGET });
  const picked = bundle.targetFile?.path;
  const hit1 = picked !== undefined && c.truth.includes(picked);

  const ranked = scoreFiles(repoMap.files, c.query)
    .filter((s) => s.score > 0 && !isTestFilePath(s.fileMap.path))
    .slice(0, 3)
    .map((s) => s.fileMap.path);
  const hit3 = ranked.some((p) => c.truth.includes(p));

  if (hit1) top1++;
  if (hit3) top3++;
  const tag = c.hard ? " (hard)" : "";
  if (!hit1) {
    misses.push(
      `  MISS${tag} ${c.id}: picked=${picked ?? "<none>"}  top3=[${ranked.join(", ")}]  truth=[${c.truth.join(", ")}]`,
    );
  }
}

const n = probe.cases.length;
console.log(`\n=== REAL-REPO LOCALIZATION PROBE (${probePath}) ===\n`);
console.log(`top-1 (locked target): ${top1}/${n}  (${((top1 / n) * 100).toFixed(0)}%)`);
console.log(`top-3 (in ranking):    ${top3}/${n}  (${((top3 / n) * 100).toFixed(0)}%)`);
if (misses.length) {
  console.log("\ntop-1 misses:");
  console.log(misses.join("\n"));
}
