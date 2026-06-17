import type { CheckerConfig, VerifyConfig } from "./types.ts";

export function defaultCheckers(repoRoot: string): CheckerConfig[] {
  return [
    {
      kind: "format",
      name: "biome-format",
      command: ["bunx", "biome", "check", "--diagnostic-level=error", "."],
      cwd: repoRoot,
      timeoutMs: 30_000,
    },
    {
      kind: "typecheck",
      name: "tsc",
      command: ["bunx", "tsc", "--noEmit"],
      cwd: repoRoot,
      timeoutMs: 60_000,
    },
    {
      kind: "test",
      name: "bun-test",
      command: ["bun", "test"],
      cwd: repoRoot,
      timeoutMs: 120_000,
    },
  ];
}

export function defaultVerifyConfig(repoRoot: string): VerifyConfig {
  return {
    repoRoot,
    checkers: defaultCheckers(repoRoot),
    maxCorrectionIterations: 3,
  };
}
