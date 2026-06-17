export type CheckerKind = "format" | "lint" | "typecheck" | "test" | "custom";
export type CheckStatus = "passed" | "failed" | "skipped" | "error";

export interface CheckResult {
  kind: CheckerKind;
  name: string; // e.g. "biome", "tsc", "bun test"
  status: CheckStatus;
  output: string; // raw stdout+stderr, truncated to 4000 chars
  durationMs: number;
  exitCode: number;
}

export interface VerifyResult {
  checks: CheckResult[];
  passed: boolean; // all non-skipped checks passed
  checksRun: number;
  checksPassed: number;
  failureSummary: string; // human-readable list of what failed (for model feedback)
  totalDurationMs: number;
}

export interface CheckerConfig {
  kind: CheckerKind;
  name: string;
  command: string[]; // argv, e.g. ["bunx", "biome", "check", "."]
  cwd?: string; // default: repoRoot
  timeoutMs?: number; // default: 30_000
  enabled?: boolean; // default: true
}

export interface VerifyConfig {
  repoRoot: string;
  checkers: CheckerConfig[];
  maxCorrectionIterations: number; // how many self-correction turns before giving up
}

export interface CorrectionIteration {
  iteration: number;
  verifyResult: VerifyResult;
  correctionPrompt: string;
  modelResponse?: string;
  applied: boolean;
}

export interface SelfCorrectionResult {
  iterations: CorrectionIteration[];
  finalVerifyResult: VerifyResult;
  converged: boolean; // true if all checks pass within iterations
  iterationsUsed: number;
}
