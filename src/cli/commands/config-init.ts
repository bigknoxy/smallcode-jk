import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ParsedArgs } from "../args.ts";

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  if (typeof val === "string") return val;
  return undefined;
}

function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

export async function configInitCommand(args: ParsedArgs): Promise<void> {
  const outputPath = resolve(flagString(args.flags, "output") ?? "./smallcode.config.json");
  const endpoint = flagString(args.flags, "endpoint") ?? "http://localhost:11434/v1";
  const model = flagString(args.flags, "model") ?? "vibethinker-3b";
  const force = flagBool(args.flags, "force");

  if (existsSync(outputPath) && !force) {
    process.stderr.write(
      `[smallcode] Error: "${outputPath}" already exists. Use --force to overwrite.\n`,
    );
    process.exit(1);
  }

  const config = {
    config: {
      provider: {
        baseUrl: endpoint,
        apiKey: "none",
        timeoutMs: 120000,
      },
      activeModel: model,
      sandbox: {
        enabled: true,
        requireApproval: true,
        allowedCommands: ["bun", "bunx", "tsc", "biome", "git"],
        networkAccess: false,
      },
      eval: {
        suitesDir: "evals/suites",
        transcriptsDir: "evals/transcripts",
        defaultTrials: 1,
      },
      maxTurns: 15,
      bestOfN: 1,
      // R1 escalation ladder: model ids cheapest-first. With the default
      // bestOfN:1 this is SINGLE-SHOT escalate-on-failure — run 3b; if the fix
      // fails, revert the agent's edits and retry with 7b (only pays for the
      // bigger model on the residual; every rung is local). Two 3b/7b rungs are
      // safe on modest hardware. Bigger box? append a larger local model, e.g.
      // "qwen2.5-coder:32b". An explicit `--model <id>` overrides this ladder and
      // runs that one model. With bestOfN>1 the same ladder is climbed across
      // attempts (needs a clean git tree). Empty [] = run activeModel alone.
      escalation: ["qwen2.5-coder:3b", "qwen2.5-coder:7b"] as string[],
    },
  };

  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  process.stdout.write(`[smallcode] Config written to ${outputPath}\n`);
}
