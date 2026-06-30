#!/usr/bin/env bun
// R5: vendor a subset of the Aider polyglot-benchmark JavaScript exercises into
// smallcode eval fixtures. Each exercise → a fixture (stub + un-skipped spec +
// MIT/Exercism attribution) + a sparse solution overlay (the reference proof) +
// a task JSON in the `aider-polyglot` suite. Validates each: the STUB must be red
// (throws) and the SOLUTION must be green under `bun test`; only solvable, clean
// single-file exercises are kept.
//
//   bun scripts/vendor-polyglot.ts                 # default curated list
//   POLYGLOT_EXERCISES=binary,triangle bun scripts/vendor-polyglot.ts
import { mkdir, writeFile, rm, mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RAW = "https://raw.githubusercontent.com/Aider-AI/polyglot-benchmark/main/javascript/exercises/practice";
const ROOT = join(import.meta.dir, "..");
const FIX = join(ROOT, "evals/fixtures");
const SUITE = join(ROOT, "evals/suites/aider-polyglot");

// Curated single-file candidates (validation prunes multi-file / unsolvable ones).
const DEFAULT = [
  "binary", "sum-of-multiples", "triangle", "transpose", "grade-school", "space-age",
  "pig-latin", "scale-generator", "resistor-color-trio", "palindrome-products", "say",
  "wordy", "queen-attack", "robot-name", "two-bucket", "variable-length-quantity",
  "phone-number", "bowling", "complex-numbers", "rational-numbers", "perfect-numbers",
  "collatz-conjecture", "darts", "high-scores", "matching-brackets",
];

const LICENSE = `MIT License

Copyright (c) 2021 Exercism

Exercise content vendored from the exercism/javascript track via the
Aider-AI/polyglot-benchmark repository. Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`;

async function getText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/** Un-skip Exercism specs: shipped specs skip all but the first case. */
function unskip(spec: string): string {
  return spec.replaceAll("xtest(", "test(").replaceAll("xit(", "it(").replaceAll("xdescribe(", "describe(");
}

function bunTest(dir: string): boolean {
  const p = Bun.spawnSync(["bun", "test"], { cwd: dir, timeout: 60_000 });
  return (p.exitCode ?? 1) === 0;
}

const names = (process.env.POLYGLOT_EXERCISES?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT);
await mkdir(SUITE, { recursive: true });
await writeFile(
  join(SUITE, "suite.json"),
  `${JSON.stringify({ id: "aider-polyglot-js-v1", kind: "capability", description: "Aider polyglot-benchmark JavaScript exercises (Exercism, MIT). Stub→implement; bun test exit-0 oracle. Reports pass@1 + edit-format-correctness.", defaultTrials: 1 }, null, 2)}\n`,
);

let kept = 0;
const skipped: string[] = [];

for (const name of names) {
  const cfgRaw = await getText(`${RAW}/${name}/.meta/config.json`);
  if (!cfgRaw) { skipped.push(`${name} (no config)`); continue; }
  let cfg: { files?: { solution?: string[]; test?: string[]; example?: string[] } };
  try { cfg = JSON.parse(cfgRaw); } catch { skipped.push(`${name} (bad config)`); continue; }
  const stubPath = cfg.files?.solution?.[0];
  const testPath = cfg.files?.test?.[0];
  const examplePath = cfg.files?.example?.[0];
  // Single-file only for v1.
  if (!stubPath || !testPath || !examplePath ||
      (cfg.files?.solution?.length ?? 0) > 1 || (cfg.files?.test?.length ?? 0) > 1) {
    skipped.push(`${name} (multi-file or missing)`); continue;
  }

  const [stub, testSrc, example, instr] = await Promise.all([
    getText(`${RAW}/${name}/${stubPath}`),
    getText(`${RAW}/${name}/${testPath}`),
    getText(`${RAW}/${name}/${examplePath}`),
    getText(`${RAW}/${name}/.docs/instructions.md`),
  ]);
  if (!stub || !testSrc || !example || !instr) { skipped.push(`${name} (missing files)`); continue; }
  const spec = unskip(testSrc);

  // Validate in a temp dir: stub must be RED, solution must be GREEN.
  const tmp = await mkdtemp(join(tmpdir(), `pg-${name}-`));
  try {
    await writeFile(join(tmp, "package.json"), `{"name":"${name}","type":"module"}`);
    await writeFile(join(tmp, testPath), spec);
    await writeFile(join(tmp, stubPath), stub);
    const stubRed = !bunTest(tmp);
    await writeFile(join(tmp, stubPath), example);
    const solGreen = bunTest(tmp);
    if (!stubRed || !solGreen) {
      skipped.push(`${name} (stubRed=${stubRed} solGreen=${solGreen})`);
      continue;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // Write the fixture + sparse solution overlay + task JSON.
  const id = `polyglot-${name}`;
  const fdir = join(FIX, id);
  await rm(fdir, { recursive: true, force: true });
  await rm(join(FIX, `${id}-solution`), { recursive: true, force: true });
  await mkdir(fdir, { recursive: true });
  await mkdir(join(FIX, `${id}-solution`), { recursive: true });
  await writeFile(join(fdir, "package.json"), `{"name":"${name}","type":"module"}\n`);
  await writeFile(join(fdir, "LICENSE"), LICENSE);
  await writeFile(join(fdir, stubPath), stub);
  await writeFile(join(fdir, testPath), spec);
  await writeFile(join(FIX, `${id}-solution`, stubPath), example);

  await writeFile(
    join(SUITE, `${id}.json`),
    `${JSON.stringify({
      id,
      desc: `${instr.trim()}\n\nImplement the solution in ${stubPath} so that ${testPath} passes. Do not modify the test file.`,
      setup: { repoFixture: id },
      graders: [{ type: "deterministic_tests", required: [], command: `bun test ${testPath}` }],
      tracked_metrics: ["n_turns", "n_toolcalls", "n_total_tokens", "pass_at_1", "editFormatOk"],
      tags: ["aider-polyglot", "javascript", name],
      reference_solution: `${id}-solution/`,
    }, null, 2)}\n`,
  );
  kept++;
  console.log(`  ✓ ${id}  (stub ${stubPath}, test ${testPath})`);
}

console.log(`\n[vendor-polyglot] kept ${kept}/${names.length} exercises → evals/suites/aider-polyglot`);
if (skipped.length) console.log(`[vendor-polyglot] skipped: ${skipped.join(", ")}`);
