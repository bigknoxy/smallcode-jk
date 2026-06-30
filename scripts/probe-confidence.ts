#!/usr/bin/env bun
// Oracle-free static-confidence probe (no model). Quantifies HONESTLY what the
// static-confidence signal catches when there is no test oracle:
//   - buggy-but-compiles (wrong logic) vs the correct solution → SAME confidence?
//     (it should be — static can't see logic; this is the limitation, stated.)
//   - a structurally-broken edit (syntax/undefined) → DOWNGRADED? (it should be —
//     that's the safety value.)
// For each fixture we hide the tests (oracle takes the no-test path) and grade the
// buggy base, the solution, and a structurally-broken variant.
import { mkdtemp, writeFile, rm, mkdir, readdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTieredOracle } from "../src/verify/oracle.ts";

const ROOT = join(import.meta.dir, "..");
const FIX = join(ROOT, "evals/fixtures");

// A representative spread: small/medium edit-rel + a realrepo.
const FIXTURES = [
  "edit-rel-smallfile-wrongop_1",
  "edit-rel-smallfile-offbyone_1",
  "edit-rel-mediumfile-wrongreturn_1",
  "edit-rel-heldout-clampinvert_1",
  "realrepo-dset-deepset_1",
];

async function srcFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, rel: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), r);
      else out.push(r);
    }
  }
  await walk(join(dir, "src"), "");
  return out;
}

// Build a temp repo = fixture WITHOUT its tests dir, optionally overlay/break src.
async function stage(
  id: string,
  mutate: "buggy" | "solution" | "broken",
): Promise<string> {
  const src = join(FIX, id);
  const dir = await mkdtemp(join(tmpdir(), `conf-${id}-`));
  // copy everything except tests/
  for (const e of await readdir(src, { withFileTypes: true })) {
    if (e.name === "tests") continue;
    await cp(join(src, e.name), join(dir, e.name), { recursive: true });
  }
  if (mutate === "solution") {
    const sol = join(FIX, `${id}-solution`);
    try {
      await cp(sol, dir, { recursive: true });
    } catch {}
  } else if (mutate === "broken") {
    // Append a structural break to the first source file.
    const files = await srcFiles(src);
    const target = files[0];
    if (target) {
      const p = join(dir, "src", target);
      const cur = await Bun.file(p).text();
      await writeFile(p, `${cur}\nexport const __broken = (() => { return ; ;;; @@@ }`);
    }
  }
  return dir;
}

const rows: string[] = [];
let sameLogic = 0;
let brokenCaught = 0;
for (const id of FIXTURES) {
  const grade = async (m: "buggy" | "solution" | "broken") => {
    const dir = await stage(id, m);
    try {
      const v = await runTieredOracle(dir, {});
      return v.outcome === "clean" ? (v.confidence?.level ?? "clean?") : v.outcome;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const buggy = await grade("buggy");
  const solution = await grade("solution");
  const broken = await grade("broken");
  const same = buggy === solution;
  const caught = broken !== buggy; // structural break changed the grade
  if (same) sameLogic++;
  if (caught) brokenCaught++;
  rows.push(
    `  ${id.padEnd(34)} buggy=${String(buggy).padEnd(14)} solution=${String(solution).padEnd(14)} broken=${broken}` +
      `  ${same ? "[logic: indistinguishable]" : "[logic: DIFFERS]"} ${caught ? "[break: caught]" : "[break: missed]"}`,
  );
}

console.log("Static-confidence probe (tests hidden → oracle-free path):\n");
console.log(rows.join("\n"));
console.log(
  `\nLogic blindness: ${sameLogic}/${FIXTURES.length} fixtures grade buggy == solution (static CANNOT see wrong logic — by design; needs a test).`,
);
console.log(
  `Structural safety: ${brokenCaught}/${FIXTURES.length} fixtures downgrade a structurally-broken edit (static DOES catch build breakage).`,
);
