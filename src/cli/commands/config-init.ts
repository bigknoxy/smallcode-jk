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
      // R1 escalation ladder (optional): model ids cheapest-first, tried across
      // Best-of-N attempts. Empty = run activeModel alone (low-resource default).
      // With bigger hardware set bestOfN>1 and escalate as high as your box allows
      // — every rung is local. Example:
      //   "bestOfN": 3,
      //   "escalation": ["qwen2.5-coder:3b", "qwen2.5-coder:7b", "gemma4:12b"]
      escalation: [] as string[],
    },
  };

  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  process.stdout.write(`[smallcode] Config written to ${outputPath}\n`);
}
