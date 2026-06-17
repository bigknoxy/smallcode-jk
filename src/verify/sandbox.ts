import path from "node:path";

export interface VerifySandboxConfig {
  repoRoot: string;
  allowedCommands: string[]; // basename allowlist
  requireApproval: boolean;
  dryRun: boolean; // if true: log actions but don't execute
}

export interface SandboxResult {
  allowed: boolean;
  reason?: string; // why blocked, if not allowed
  dryRun: boolean;
}

export function checkCommand(cmd: string[], config: VerifySandboxConfig): SandboxResult {
  const binary = path.basename(cmd[0] ?? "");

  if (config.dryRun) {
    return {
      allowed: true,
      reason: `Dry-run: command not executed: ${binary}`,
      dryRun: true,
    };
  }

  if (!config.allowedCommands.includes(binary)) {
    return {
      allowed: false,
      reason: `Command not in allowlist: ${binary}`,
      dryRun: false,
    };
  }

  return { allowed: true, dryRun: false };
}

export function checkFilePath(filePath: string, config: VerifySandboxConfig): SandboxResult {
  const base = path.resolve(config.repoRoot) + path.sep;
  const abs = path.resolve(config.repoRoot, filePath);

  if (!(abs + path.sep).startsWith(base)) {
    return {
      allowed: false,
      reason: `Path traversal rejected: ${filePath}`,
      dryRun: config.dryRun,
    };
  }

  return { allowed: true, dryRun: config.dryRun };
}

export function defaultVerifySandboxConfig(repoRoot: string): VerifySandboxConfig {
  return {
    repoRoot,
    allowedCommands: ["bun", "bunx", "tsc", "biome", "git"],
    requireApproval: true,
    dryRun: false,
  };
}
