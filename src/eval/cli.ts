import { resolve } from "node:path";
import { loadConfig } from "../config/loader.ts";
import { runSuite } from "./runner.ts";
import { loadSuite } from "./task-loader.ts";
import type { EvalRunResult, EvalSuite } from "./types.ts";
import { renderEvalRunResult } from "./viewer.ts";

export interface EvalRunCommandArgs {
  suite: string; // path to suite directory
  model: string; // model id
  configPath?: string; // smallcode.config.json path
  trials?: number; // override default trials
  transcriptsDir?: string;
  fixturesRoot?: string;
  output?: "json" | "text";
}

export async function evalRunCommand(args: EvalRunCommandArgs): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Load config
  // -------------------------------------------------------------------------
  let cfg: ReturnType<typeof loadConfig>["config"] | null = null;
  try {
    cfg = loadConfig(args.configPath).config;
  } catch (err) {
    // Config is optional for eval — warn but continue with defaults
    process.stderr.write(`Warning: could not load config: ${String(err)}\n`);
  }

  // -------------------------------------------------------------------------
  // 2. Load suite
  // -------------------------------------------------------------------------
  const suiteDir = resolve(args.suite);
  let suite: EvalSuite;
  try {
    suite = await loadSuite(suiteDir);
  } catch (err) {
    process.stderr.write(`Error: failed to load suite from "${suiteDir}": ${String(err)}\n`);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 3. Resolve run options
  // -------------------------------------------------------------------------
  const modelId = args.model ?? cfg?.activeModel ?? "unknown";
  const trials = args.trials ?? cfg?.eval?.defaultTrials ?? 1;
  const transcriptsDir = args.transcriptsDir ?? cfg?.eval?.transcriptsDir ?? "evals/transcripts";
  const fixturesRoot = args.fixturesRoot ?? "evals/fixtures";
  const outputFormat = args.output ?? "text";

  // -------------------------------------------------------------------------
  // 4. Run suite
  // -------------------------------------------------------------------------
  let result: EvalRunResult;
  try {
    result = await runSuite(suite, {
      model: modelId,
      trials,
      transcriptsDir,
      fixturesRoot,
    });
  } catch (err) {
    process.stderr.write(`Error: suite run failed: ${String(err)}\n`);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 5. Output result
  // -------------------------------------------------------------------------
  if (outputFormat === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderEvalRunResult(result)}\n`);
  }

  // -------------------------------------------------------------------------
  // 6. Exit code: 1 if any tasks failed
  // -------------------------------------------------------------------------
  if (result.totalTasksPassed < result.taskResults.length) {
    process.exit(1);
  }
}
