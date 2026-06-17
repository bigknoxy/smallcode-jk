import { parse } from "@/edit/index.ts";
import type { ApplyResult, EditBlock } from "@/edit/types.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { Provider } from "@/provider/types.ts";
import type { ReasoningHandler } from "@/reasoning/handler.ts";
import { formatVerifyFeedback } from "./feedback.ts";
import type {
  CorrectionIteration,
  SelfCorrectionResult,
  VerifyConfig,
  VerifyResult,
} from "./types.ts";

export interface CorrectorDependencies {
  provider: Provider;
  profile: ModelProfile;
  reasoningHandler: ReasoningHandler;
  runVerify: () => Promise<VerifyResult>;
  applyEdits: (blocks: EditBlock[]) => Promise<ApplyResult[]>;
  systemPrompt: string;
}

export async function runSelfCorrection(
  config: VerifyConfig,
  deps: CorrectorDependencies,
): Promise<SelfCorrectionResult> {
  // Step 1: Run initial verify
  let verifyResult: VerifyResult;
  try {
    verifyResult = await deps.runVerify();
  } catch (err) {
    // If initial verify throws, build a minimal failed result
    const msg = err instanceof Error ? err.message : String(err);
    verifyResult = {
      checks: [],
      passed: false,
      checksRun: 0,
      checksPassed: 0,
      failureSummary: `Initial verify error: ${msg}`,
      totalDurationMs: 0,
    };
  }

  // Step 2: Already passing — return immediately
  if (verifyResult.passed) {
    return {
      iterations: [],
      finalVerifyResult: verifyResult,
      converged: true,
      iterationsUsed: 0,
    };
  }

  const iterations: CorrectionIteration[] = [];

  // Step 3: Correction loop
  for (let iteration = 1; iteration <= config.maxCorrectionIterations; iteration++) {
    const correctionPrompt = formatVerifyFeedback(
      verifyResult,
      iteration,
      config.maxCorrectionIterations,
    );

    // Build CompletionRequest
    const { samplingDefaults } = deps.profile;
    const request = {
      model: deps.profile.id,
      messages: [
        { role: "system" as const, content: deps.systemPrompt },
        { role: "user" as const, content: correctionPrompt },
      ],
      temperature: samplingDefaults.temperature,
      top_p: samplingDefaults.top_p,
      top_k: samplingDefaults.top_k,
      max_tokens: samplingDefaults.max_tokens,
    };

    // Call provider — catch errors
    let modelResponse: string | undefined;
    let applied = false;

    try {
      const response = await deps.provider.complete(request);
      modelResponse = response.rawContent;

      // Parse reasoning
      const parsed = deps.reasoningHandler.parse(response.rawContent);
      const answer = parsed.answer;

      // Parse edit blocks
      const parseResult = parse(answer);

      // Apply if blocks found
      if (parseResult.blocks.length > 0) {
        await deps.applyEdits(parseResult.blocks);
        applied = true;
      }
    } catch (_err) {
      // Record iteration with applied=false, then break
      iterations.push({
        iteration,
        verifyResult,
        correctionPrompt,
        modelResponse,
        applied: false,
      });
      break;
    }

    // Re-run verify
    try {
      verifyResult = await deps.runVerify();
    } catch (verifyErr) {
      const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      verifyResult = {
        checks: [],
        passed: false,
        checksRun: 0,
        checksPassed: 0,
        failureSummary: `Verify error: ${msg}`,
        totalDurationMs: 0,
      };
    }

    // Record this iteration
    iterations.push({
      iteration,
      verifyResult,
      correctionPrompt,
      modelResponse,
      applied,
    });

    // Check convergence
    if (verifyResult.passed) {
      break;
    }
  }

  const converged = verifyResult.passed;
  return {
    iterations,
    finalVerifyResult: verifyResult,
    converged,
    iterationsUsed: iterations.length,
  };
}
