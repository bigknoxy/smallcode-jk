// Eval suite runner — Phase 7 will flesh this out; stub here keeps tsc happy
// and lets the CLI wire through correctly.

import type { EvalRunResult, EvalSuite } from "./types.ts";

export interface RunSuiteOptions {
  model: string;
  trials?: number;
  transcriptsDir?: string;
  fixturesRoot?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider?: unknown;
}

/**
 * Runs all tasks in a suite and returns an EvalRunResult.
 * This is a minimal placeholder; full implementation in Phase 7.
 */
export async function runSuite(suite: EvalSuite, opts: RunSuiteOptions): Promise<EvalRunResult> {
  // Stub: returns an empty-run result so the CLI can compile and run
  const now = Date.now();
  return {
    runId: `run-${now}`,
    suiteId: suite.id,
    modelId: opts.model,
    taskResults: [],
    overallPassAt1: 0,
    totalTrials: 0,
    totalTasksPassed: 0,
    startedAt: now,
    finishedAt: now,
  };
}
