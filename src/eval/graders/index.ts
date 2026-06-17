import type { GraderConfig, GraderResult, Transcript } from "../types.ts";
import { runDeterministicGrader } from "./deterministic.ts";
import type { LLMJudgeOptions } from "./llm.ts";
import { runLLMGrader } from "./llm.ts";
import { runStaticGrader } from "./static.ts";

// Re-export for consumers
export type { LLMJudgeOptions } from "./llm.ts";

// ---------------------------------------------------------------------------
// Grader dispatcher — routes to the appropriate grader by type
// ---------------------------------------------------------------------------

export async function runGrader(
  grader: GraderConfig,
  trialDir: string,
  transcript: Transcript,
  llmOpts?: LLMJudgeOptions,
): Promise<GraderResult> {
  switch (grader.type) {
    case "deterministic_tests":
      return runDeterministicGrader(grader, trialDir);

    case "static_analysis":
      return runStaticGrader(grader, trialDir);

    case "llm_rubric":
      if (!llmOpts) {
        throw new Error("runGrader: llmOpts must be provided when grader type is 'llm_rubric'");
      }
      return runLLMGrader(grader, transcript, trialDir, llmOpts);
  }
}
