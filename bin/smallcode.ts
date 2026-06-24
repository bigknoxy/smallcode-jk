#!/usr/bin/env bun
import { parseArgs } from "../src/cli/args.ts";
import { runCommand } from "../src/cli/commands/run.ts";
import { configInitCommand } from "../src/cli/commands/config-init.ts";
import { configModelsCommand } from "../src/cli/commands/config-models.ts";
import { updateCommand, uninstallCommand } from "../src/cli/commands/selfmanage.ts";
import { evalRunCommand } from "../src/eval/cli.ts";
import { loadConfig } from "../src/config/loader.ts";
import { loadSuite } from "../src/eval/task-loader.ts";
import { runSuite } from "../src/eval/runner.ts";
import { runGate } from "../src/improve/regression-gate.ts";
import { MetricsStore } from "../src/improve/metrics-store.ts";
import { resolve } from "node:path";

// Read version from package.json
const pkgPath = new URL("../package.json", import.meta.url);
let version = "0.0.0";
try {
  const pkg = await Bun.file(pkgPath).json() as { version?: string };
  version = pkg.version ?? "0.0.0";
} catch {
  // fallback
}

function printUsage(): void {
  process.stdout.write(`smallcode v${version}

Usage:
  smallcode run <task description>
  smallcode eval run <suite-dir> [--model <id>] [--trials <n>] [--output json|text]
  smallcode eval gate <suite-dir> [--threshold 0.9] [--allow-delta 0.05]
  smallcode config init [--model <id>] [--endpoint <url>] [--output <path>] [--force]
  smallcode config list-models
  smallcode update
  smallcode uninstall [--yes|-y]
  smallcode --version
  smallcode --help
`);
}

const argv = process.argv.slice(2);
const parsed = parseArgs(argv);

try {
  switch (parsed.command) {
    case "version":
      process.stdout.write(`smallcode v${version}\n`);
      break;

    case "help":
      printUsage();
      break;

    case "run":
      await runCommand(parsed);
      break;

    case "config":
      if (parsed.subcommand === "init") {
        await configInitCommand(parsed);
      } else if (parsed.subcommand === "list-models") {
        await configModelsCommand();
      } else {
        process.stderr.write(`[smallcode] Unknown config subcommand: "${parsed.subcommand ?? ""}"\n`);
        printUsage();
        process.exit(1);
      }
      break;

    case "update":
      await updateCommand(parsed);
      break;

    case "uninstall":
      await uninstallCommand(parsed);
      break;

    case "eval": {
      if (parsed.subcommand === "run") {
        const suiteDir = parsed.positionals[0];
        if (!suiteDir) {
          process.stderr.write("[smallcode] Error: missing <suite-dir> for eval run\n");
          process.exit(1);
        }

        const flags = parsed.flags;
        const model = (typeof flags["model"] === "string" ? flags["model"] : undefined);
        const trialsRaw = (typeof flags["trials"] === "string" ? flags["trials"] : undefined);
        const trials = trialsRaw !== undefined ? parseInt(trialsRaw, 10) : undefined;
        const outputRaw = (typeof flags["output"] === "string" ? flags["output"] : undefined);
        const output = (outputRaw === "json" || outputRaw === "text") ? outputRaw : undefined;
        const configPath = (typeof flags["config"] === "string" ? flags["config"] : undefined);

        // Resolve model: flag > config activeModel
        let resolvedModel = model;
        if (resolvedModel === undefined) {
          try {
            resolvedModel = loadConfig(configPath).config.activeModel;
          } catch {
            resolvedModel = "unknown";
          }
        }

        await evalRunCommand({
          suite: suiteDir,
          model: resolvedModel,
          configPath,
          trials,
          output,
        });
      } else if (parsed.subcommand === "gate") {
        const suiteDir = parsed.positionals[0];
        if (!suiteDir) {
          process.stderr.write("[smallcode] Error: missing <suite-dir> for eval gate\n");
          process.exit(1);
        }

        const flags = parsed.flags;
        const thresholdRaw = typeof flags["threshold"] === "string" ? flags["threshold"] : "0.9";
        const allowDeltaRaw = typeof flags["allow-delta"] === "string" ? flags["allow-delta"] : undefined;
        const configPath = typeof flags["config"] === "string" ? flags["config"] : undefined;
        const model = typeof flags["model"] === "string" ? flags["model"] : undefined;

        const threshold = parseFloat(thresholdRaw);
        const allowDelta = allowDeltaRaw !== undefined ? parseFloat(allowDeltaRaw) : undefined;

        // Load config for model/transcriptsDir
        let resolvedModel = model ?? "unknown";
        let transcriptsDir = "evals/transcripts";
        try {
          const cfg = loadConfig(configPath).config;
          if (model === undefined) resolvedModel = cfg.activeModel;
          transcriptsDir = cfg.eval?.transcriptsDir ?? transcriptsDir;
        } catch {
          // optional
        }

        const suite = await loadSuite(resolve(suiteDir));
        const result = await runSuite(suite, {
          model: resolvedModel,
          trials: 1,
          transcriptsDir,
          fixturesRoot: "evals/fixtures",
        });

        const storePath = `${transcriptsDir}/metrics.ndjson`;
        const store = new MetricsStore(storePath);
        const gateResult = await runGate(result, store, { threshold, allowDelta }, Date.now());

        process.stdout.write(`${gateResult.message}\n`);
        if (!gateResult.passed) {
          process.exit(1);
        }
      } else {
        process.stderr.write(`[smallcode] Unknown eval subcommand: "${parsed.subcommand ?? ""}"\n`);
        printUsage();
        process.exit(1);
      }
      break;
    }

    default:
      process.stderr.write(`[smallcode] Unknown command: "${parsed.command}"\n`);
      printUsage();
      process.exit(1);
  }
} catch (err) {
  process.stderr.write(`[smallcode] Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
