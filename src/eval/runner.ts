// Eval suite runner. Builds the model provider + agent loop dependencies from a
// resolved config, then delegates to harness.ts's runSuite (the real per-task
// runTask loop). This is what `smallcode eval run` / `eval gate` call — before,
// this file was a Phase-7 stub that returned an empty EvalRunResult, so the CLI
// produced zero trials (and `--save-transcripts` saved nothing). Now it runs.

import type { SmallcodeConfig } from "../config/types.ts";
import { defaultRegistry } from "../models/index.ts";
import { createProvider } from "../provider/factory.ts";
import { ReasoningHandler } from "../reasoning/handler.ts";
import { runSuite as runSuiteHarness } from "./harness.ts";
import type { EvalRunResult, EvalSuite } from "./types.ts";

export interface RunSuiteOptions {
  /** Model id to run (resolved against defaultRegistry). */
  model: string;
  /** Resolved config — REQUIRED: the provider endpoint drives every model call. */
  config: SmallcodeConfig;
  trials?: number;
  transcriptsDir?: string;
  fixturesRoot?: string;
}

/**
 * Runs all tasks in a suite and returns an EvalRunResult with real per-trial
 * results (each `TaskEvalResult.trials[].transcript` populated). The agent loop
 * deps are built here the same way scripts/run-baseline.ts builds them: one
 * shared provider (local models select per-request by id), the model's profile,
 * a reasoning handler, and a per-eval AgentConfig with approval OFF (eval is
 * non-interactive).
 */
export async function runSuite(suite: EvalSuite, opts: RunSuiteOptions): Promise<EvalRunResult> {
  const profile = defaultRegistry.get(opts.model);
  const provider = createProvider(opts.config.provider, defaultRegistry);
  const reasoningHandler = new ReasoningHandler(
    profile.reasoningTags ?? { open: "<think>", close: "</think>" },
  );

  const agentConfig = {
    repoRoot: process.cwd(), // overridden per trial inside runTask (each trial gets its own dir)
    modelId: profile.id,
    maxTurns: opts.config.maxTurns,
    bestOfN: opts.config.bestOfN,
    allowedCommands: opts.config.sandbox.allowedCommands,
    requireApproval: false, // eval is non-interactive — never block on approval
  };

  return runSuiteHarness(suite, {
    ...(opts.trials !== undefined ? { trialsPerTask: opts.trials } : {}),
    fixturesRoot: opts.fixturesRoot ?? "evals/fixtures",
    transcriptsDir: opts.transcriptsDir ?? "evals/transcripts",
    agentConfig,
    loopDeps: { provider, profile, reasoningHandler, config: agentConfig },
  });
}
