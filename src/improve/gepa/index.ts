/**
 * GEPA module barrel — re-exports all public API.
 */

export type { Candidate, FailedInstance, GepaConfig, Transcript } from "./types.ts";
export { dominates, ParetoFront } from "./pareto-front.ts";
export type { ReflectiveMutator } from "./mutator.ts";
export { MockMutator } from "./mutator.ts";
export {
  LLMReflectiveMutator,
  buildReflectionPrompt,
  extractDelimitedBlock,
  makeProviderComplete,
  reflectConfigFromEnv,
  NEW_SYSTEM_OPEN,
  NEW_SYSTEM_CLOSE,
} from "./reflective-mutator.ts";
export type {
  ReflectiveMutatorDeps,
  ProviderCompleteConfig,
  BuildReflectionPromptOpts,
} from "./reflective-mutator.ts";
export type { EvaluateAdapterDeps } from "./evaluate-adapter.ts";
export { evaluateCandidate } from "./evaluate-adapter.ts";
export type { GepaEngineDeps } from "./engine.ts";
export { runGepa } from "./engine.ts";
