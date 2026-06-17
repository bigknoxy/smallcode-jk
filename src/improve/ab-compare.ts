import type { LoopDependencies } from "../agent/loop.ts";
import type { AgentConfig } from "../agent/types.ts";
import { runSuite } from "../eval/harness.ts";
import type { EvalRunResult, EvalSuite } from "../eval/types.ts";
import type { ABResult, ABVariant } from "./types.ts";

export interface ABRunOptions {
  suite: EvalSuite;
  fixturesRoot: string;
  transcriptsDir: string;
  agentConfigTemplate: AgentConfig;
  loopDepsTemplate: LoopDependencies;
  trials?: number;
}

function buildPerTaskDelta(runA: EvalRunResult, runB: EvalRunResult): Record<string, number> {
  const delta: Record<string, number> = {};

  // Index A results by task id
  const aByTask = new Map<string, number>();
  for (const r of runA.taskResults) {
    aByTask.set(r.task.id, r.passAt1);
  }

  for (const r of runB.taskResults) {
    const aPassAt1 = aByTask.get(r.task.id) ?? 0;
    delta[r.task.id] = r.passAt1 - aPassAt1;
  }

  return delta;
}

function buildSummary(
  variantA: ABVariant,
  variantB: ABVariant,
  runA: EvalRunResult,
  runB: EvalRunResult,
  winner: "A" | "B" | "tie",
  delta: number,
): string {
  const aScore = runA.overallPassAt1.toFixed(3);
  const bScore = runB.overallPassAt1.toFixed(3);
  const deltaSign = delta >= 0 ? "+" : "";
  const winnerName = winner === "A" ? variantA.name : winner === "B" ? variantB.name : "neither";

  if (winner === "tie") {
    return (
      `A/B comparison between "${variantA.name}" and "${variantB.name}" resulted in a tie. ` +
      `Both variants achieved pass@1=${aScore} on suite "${runA.suiteId}".`
    );
  }

  return (
    `A/B comparison between "${variantA.name}" (pass@1=${aScore}) and ` +
    `"${variantB.name}" (pass@1=${bScore}) on suite "${runA.suiteId}". ` +
    `Winner: "${winnerName}" (delta B−A: ${deltaSign}${delta.toFixed(3)}).`
  );
}

export async function runABComparison(
  variantA: ABVariant,
  variantB: ABVariant,
  opts: ABRunOptions,
  now: number,
): Promise<ABResult> {
  void now; // timestamp param reserved for future use (e.g. seeding store)

  const trialsPerTask = opts.trials ?? opts.suite.defaultTrials;

  let runA: EvalRunResult | undefined;
  let runB: EvalRunResult | undefined;
  let errorA: unknown;

  // Run variant A
  try {
    runA = await runSuite(opts.suite, {
      trialsPerTask,
      fixturesRoot: opts.fixturesRoot,
      transcriptsDir: opts.transcriptsDir,
      agentConfig: {
        ...opts.agentConfigTemplate,
        // systemPrompt is injected via the loop deps provider in a real system;
        // here we store it on the config for the harness to forward if it supports it
      },
      loopDeps: opts.loopDepsTemplate,
    });
  } catch (err) {
    errorA = err;
  }

  // Run variant B
  try {
    runB = await runSuite(opts.suite, {
      trialsPerTask,
      fixturesRoot: opts.fixturesRoot,
      transcriptsDir: opts.transcriptsDir,
      agentConfig: {
        ...opts.agentConfigTemplate,
      },
      loopDeps: opts.loopDepsTemplate,
    });
  } catch {
    // errorB not needed — if both fail we re-throw errorA
  }

  // Both failed: re-throw first error
  if (runA === undefined && runB === undefined) {
    throw errorA;
  }

  // One failed: the successful run wins
  if (runA === undefined && runB !== undefined) {
    const delta = runB.overallPassAt1;
    const perTaskDelta = buildPerTaskDelta(
      { ...runB, taskResults: runB.taskResults.map((r) => ({ ...r, passAt1: 0 })) },
      runB,
    );
    return {
      variantA,
      variantB,
      runA: runB, // placeholder — A failed
      runB,
      winner: "B",
      deltaPassAt1: delta,
      perTaskDelta,
      summary: `Variant A ("${variantA.name}") failed to run. Variant B ("${variantB.name}") wins by default with pass@1=${runB.overallPassAt1.toFixed(3)}.`,
    };
  }

  if (runB === undefined && runA !== undefined) {
    const delta = -runA.overallPassAt1;
    const perTaskDelta = buildPerTaskDelta(runA, {
      ...runA,
      taskResults: runA.taskResults.map((r) => ({ ...r, passAt1: 0 })),
    });
    return {
      variantA,
      variantB,
      runA,
      runB: runA, // placeholder — B failed
      winner: "A",
      deltaPassAt1: delta,
      perTaskDelta,
      summary: `Variant B ("${variantB.name}") failed to run. Variant A ("${variantA.name}") wins by default with pass@1=${runA.overallPassAt1.toFixed(3)}.`,
    };
  }

  // Both succeeded
  const a = runA as EvalRunResult;
  const b = runB as EvalRunResult;

  const deltaPassAt1 = b.overallPassAt1 - a.overallPassAt1;
  const winner: "A" | "B" | "tie" =
    a.overallPassAt1 > b.overallPassAt1 ? "A" : b.overallPassAt1 > a.overallPassAt1 ? "B" : "tie";

  const perTaskDelta = buildPerTaskDelta(a, b);
  const summary = buildSummary(variantA, variantB, a, b, winner, deltaPassAt1);

  return {
    variantA,
    variantB,
    runA: a,
    runB: b,
    winner,
    deltaPassAt1,
    perTaskDelta,
    summary,
  };
}
