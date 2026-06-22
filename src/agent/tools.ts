import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolCall, ToolName, ToolResult } from "./types.ts";

export interface ToolContext {
  repoRoot: string;
  allowedCommands: string[];
  requireApproval: boolean;
}

export class ApprovalRequiredError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly args: Record<string, unknown>,
  ) {
    super(`Approval required for ${toolName}: ${JSON.stringify(args)}`);
    this.name = "ApprovalRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveSafe(repoRoot: string, filePath: string): { abs: string } | { error: string } {
  // Anchor with separator so "/repo-evil" can't bypass a "/repo" root check.
  const base = path.resolve(repoRoot) + path.sep;
  const abs = path.resolve(repoRoot, filePath);
  if (!(abs + path.sep).startsWith(base)) {
    return { error: `Path traversal rejected: ${filePath}` };
  }
  return { abs };
}

// ---------------------------------------------------------------------------
// Individual tool implementations
// ---------------------------------------------------------------------------

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name: ToolName = "read_file";
  const filePath = args["path"];
  if (typeof filePath !== "string") {
    return { name, success: false, output: "", error: "Missing required arg: path" };
  }

  const resolved = resolveSafe(ctx.repoRoot, filePath);
  if ("error" in resolved) {
    return { name, success: false, output: "", error: resolved.error };
  }

  const f = Bun.file(resolved.abs);
  const exists = await f.exists();
  if (!exists) {
    return { name, success: true, output: "(file not found)" };
  }

  let content = await f.text();
  const LIMIT = 8000;
  if (content.length > LIMIT) {
    content = `${content.slice(0, LIMIT)}\n[truncated]`;
  }
  return { name, success: true, output: content };
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name: ToolName = "write_file";
  const filePath = args["path"];
  const content = args["content"];

  if (typeof filePath !== "string") {
    return { name, success: false, output: "", error: "Missing required arg: path" };
  }
  if (typeof content !== "string") {
    return { name, success: false, output: "", error: "Missing required arg: content" };
  }

  const resolved = resolveSafe(ctx.repoRoot, filePath);
  if ("error" in resolved) {
    return { name, success: false, output: "", error: resolved.error };
  }

  if (ctx.requireApproval) {
    throw new ApprovalRequiredError(name, args);
  }

  await mkdir(path.dirname(resolved.abs), { recursive: true });
  await Bun.write(resolved.abs, content);

  return { name, success: true, output: `Written: ${filePath}` };
}

async function runCommand(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name: ToolName = "run_command";
  const cmd = args["cmd"];

  if (typeof cmd !== "string") {
    return { name, success: false, output: "", error: "Missing required arg: cmd" };
  }

  const argv = cmd.trim().split(/\s+/);
  const binary = argv[0] ?? "";

  // Check allowlist — exact basename match only (prefix matching allows bypass)
  const allowed = ctx.allowedCommands.includes(path.basename(binary));
  if (!allowed) {
    return {
      name,
      success: false,
      output: "",
      error: `Command not in allowlist: ${cmd}`,
    };
  }

  // Destructive heuristic check
  const destructivePatterns = ["write", "rm", "delete", "drop"];
  const isDestructive = destructivePatterns.some((p) => cmd.includes(p));
  if (ctx.requireApproval && isDestructive) {
    throw new ApprovalRequiredError(name, args);
  }

  const start = Date.now();
  const proc = Bun.spawnSync([...argv], {
    cwd: ctx.repoRoot,
    timeout: 30_000,
  });

  const LIMIT = 4000;
  const stdoutText = proc.stdout instanceof Uint8Array ? new TextDecoder().decode(proc.stdout) : "";
  const stderrText = proc.stderr instanceof Uint8Array ? new TextDecoder().decode(proc.stderr) : "";
  let combined = stdoutText + stderrText;
  if (combined.length > LIMIT) {
    combined = `${combined.slice(0, LIMIT)}\n[truncated]`;
  }

  const durationMs = Date.now() - start;
  return {
    name,
    success: proc.exitCode === 0,
    output: combined,
    durationMs,
  };
}

async function runTests(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name: ToolName = "run_tests";
  const pattern = typeof args["pattern"] === "string" ? args["pattern"] : undefined;

  const argv = pattern ? ["bun", "test", pattern] : ["bun", "test"];

  const start = Date.now();
  const proc = Bun.spawnSync(argv, {
    cwd: ctx.repoRoot,
    timeout: 60_000,
  });

  const LIMIT = 4000;
  const stdoutText = proc.stdout instanceof Uint8Array ? new TextDecoder().decode(proc.stdout) : "";
  const stderrText = proc.stderr instanceof Uint8Array ? new TextDecoder().decode(proc.stderr) : "";
  let combined = stdoutText + stderrText;
  if (combined.length > LIMIT) {
    combined = `${combined.slice(0, LIMIT)}\n[truncated]`;
  }

  // Parse pass/fail counts
  const failMatch = combined.match(/(\d+)\s+fail/i);
  const failCount = failMatch ? parseInt(failMatch[1] ?? "0", 10) : 0;

  // Success requires a clean exit AND zero failures. `bun test` exits non-zero
  // when no test files are found, so exitCode===0 also guards against treating
  // an empty/no-tests run as green (which would falsely early-stop the agent loop).
  const durationMs = Date.now() - start;
  return {
    name,
    success: proc.exitCode === 0 && failCount === 0,
    output: combined,
    durationMs,
  };
}

function think(args: Record<string, unknown>): ToolResult {
  const name: ToolName = "think";
  // content arg is intentionally consumed but not used beyond recording
  void args["content"];
  return { name, success: true, output: "" };
}

function finish(args: Record<string, unknown>): ToolResult {
  const name: ToolName = "finish";
  const summary = typeof args["summary"] === "string" ? args["summary"] : "";
  return { name, success: true, output: summary };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "read_file":
        return await readFile(call.args, ctx);
      case "write_file":
        return await writeFile(call.args, ctx);
      case "run_command":
        return await runCommand(call.args, ctx);
      case "run_tests":
        return await runTests(call.args, ctx);
      case "think":
        return think(call.args);
      case "finish":
        return finish(call.args);
      default: {
        const _exhaustive: never = call.name;
        return {
          name: call.name,
          success: false,
          output: "",
          error: `Unknown tool: ${_exhaustive}`,
        };
      }
    }
  } catch (err) {
    // Re-throw ApprovalRequiredError — callers must handle it
    if (err instanceof ApprovalRequiredError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { name: call.name, success: false, output: "", error: msg };
  }
}
