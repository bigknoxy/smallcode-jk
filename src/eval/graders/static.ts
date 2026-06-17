import type { GraderResult, StaticAnalysisGrader } from "../types.ts";

// ---------------------------------------------------------------------------
// Static analysis grader — runs biome/tsc/custom commands in trialDir
// ---------------------------------------------------------------------------

function resolveCommand(cmd: string): string[] {
  switch (cmd) {
    case "biome":
      return ["bunx", "biome", "check", "--diagnostic-level=error", "."];
    case "tsc":
      return ["bunx", "tsc", "--noEmit"];
    default:
      return cmd.trim().split(/\s+/);
  }
}

export async function runStaticGrader(
  grader: StaticAnalysisGrader,
  trialDir: string,
): Promise<GraderResult> {
  const startMs = Date.now();

  try {
    const results: Array<{ cmd: string; exitCode: number; output: string }> = [];

    for (const cmd of grader.commands) {
      const argv = resolveCommand(cmd);
      const exe = argv[0];
      if (!exe) {
        results.push({ cmd, exitCode: 1, output: "Empty command" });
        continue;
      }

      const proc = Bun.spawnSync([exe, ...argv.slice(1)], {
        cwd: trialDir,
        timeout: 30_000,
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
      const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
      const combined = `${stdout}\n${stderr}`.trim();

      results.push({ cmd, exitCode: proc.exitCode ?? 1, output: combined });
    }

    const passCount = results.filter((r) => r.exitCode === 0).length;
    const total = results.length;
    const score = total > 0 ? passCount / total : 1;

    const allPassed = passCount === total;
    const verdict: GraderResult["verdict"] = allPassed ? "pass" : "fail";

    // Build combined output, truncated
    const combinedOutput = results
      .map((r) => `[${r.exitCode === 0 ? "PASS" : "FAIL"}] ${r.cmd}:\n${r.output}`)
      .join("\n\n");
    const truncated =
      combinedOutput.length > 2000
        ? `${combinedOutput.slice(0, 2000)}\n...[truncated]`
        : combinedOutput;

    return {
      type: "static_analysis",
      verdict,
      score,
      output: truncated,
      durationMs: Date.now() - startMs,
      details: {
        passCount,
        total,
        results: results.map((r) => ({ cmd: r.cmd, exitCode: r.exitCode })),
      },
    };
  } catch (err) {
    return {
      type: "static_analysis",
      verdict: "error",
      score: 0,
      output: String(err),
      durationMs: Date.now() - startMs,
      details: { error: String(err) },
    };
  }
}
