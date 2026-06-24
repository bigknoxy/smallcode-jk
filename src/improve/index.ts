// GEPA prompt-optimization harness
export type { Candidate as GepaCandidate, FailedInstance, GepaConfig } from "./gepa/index.ts";
export { dominates, MockMutator, ParetoFront, evaluateCandidate, runGepa } from "./gepa/index.ts";
export type { ReflectiveMutator } from "./gepa/index.ts";

export type { ABRunOptions } from "./ab-compare.ts";
export { runABComparison } from "./ab-compare.ts";
export { MetricsStore } from "./metrics-store.ts";
export { listCandidates, promoteToSuite } from "./promoter.ts";
export type { GateConfig } from "./regression-gate.ts";
export { checkRegression, runGate } from "./regression-gate.ts";
export { SessionLogger } from "./session-logger.ts";
export type { ExtractOptions } from "./task-extractor.ts";
export { extractTaskFromSession } from "./task-extractor.ts";
export type {
  ABResult,
  ABVariant,
  CandidateTask,
  MetricsHistory,
  MetricsSnapshot,
  RegressionCheckResult,
  SessionLogEntry,
} from "./types.ts";
