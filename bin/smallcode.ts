#!/usr/bin/env bun
import { parseArgs } from "../src/cli/args.ts";
import { runCommand } from "../src/cli/commands/run.ts";
import { fixCommand } from "../src/cli/commands/fix.ts";
import { configInitCommand } from "../src/cli/commands/config-init.ts";
import { configModelsCommand } from "../src/cli/commands/config-models.ts";
import { configEnvCommand } from "../src/cli/commands/config-env.ts";
import { doctorCommand } from "../src/cli/commands/doctor.ts";
import { updateCommand, uninstallCommand } from "../src/cli/commands/selfmanage.ts";
import { diffCommand, undoCommand } from "../src/cli/commands/review.ts";
import { chatCommand } from "../src/cli/commands/chat.ts";
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
  smallcode run <task description> [--model <id>] [--best-of-n <N>] [--escalation <m1,m2,..>] [--json] [--yes]
  smallcode fix [--repo <path>] [--test "<cmd>"] [--model <id>] [--best-of-n <n>] [--escalation <m1,m2>] [--json] [--max-turns <n>] [--yes]
  smallcode chat [--repo <path>] [--model <id>]   # interactive multi-task session
  smallcode diff [--repo <path>]            # show what the agent changed
  smallcode undo [--repo <path>] [--yes]    # revert the agent's changes (dry-run without --yes)
  smallcode eval run <suite-dir> [--model <id>] [--trials <n>] [--output json|text] [--save-transcripts]
  smallcode eval gate <suite-dir> [--threshold 0.9] [--allow-delta 0.05]
  smallcode config init [--model <id>] [--endpoint <url>] [--output <path>] [--force]
  smallcode config list-models
  smallcode config env
  smallcode doctor [--endpoint <url>] [--repo <path>] [--config <path>] [--json]   # diagnose your setup
  smallcode update
  smallcode uninstall [--yes|-y]
  smallcode --version
  smallcode --help

Edit approval (run / fix / chat):
  When config sandbox.requireApproval is true, each edit is shown for y/N in an
  interactive terminal. In a NON-interactive run (CI, piped, --json, delegation)
  there is no TTY to answer, so edits are APPLIED with a one-time notice — review
  with 'smallcode diff', roll back with 'smallcode undo'. Pass --yes to apply
  without prompting (and silence the notice) even in a terminal.

Model escalation (run / fix):
  --escalation <m1,m2,..>   Ordered LOCAL model ladder, cheapest first (e.g.
                            qwen2.5-coder:7b,qwen2.5-coder:32b). Also settable as
                            "escalation" in smallcode.config.json (default 3b,7b);
                            the flag wins. An explicit --model <id> overrides the
                            config ladder and runs just that one model.
    • With --best-of-n 1 (default): SINGLE-SHOT ESCALATE-ON-FAILURE. Runs the
      cheapest model; if the oracle can't confirm the fix, reverts ONLY the
      agent's own edits (your uncommitted work is preserved) and retries with the
      next bigger model. Stops on the first solve. Needs a git repo and a failing
      test to verify against; otherwise it runs the base model single-shot.
    • With --best-of-n N>1: runs N attempts up the same ladder, resolving on the
      first oracle-green attempt. Requires a CLEAN git tree (attempts roll the
      whole tree back). Everything stays on one local Ollama endpoint — offline.
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

    case "fix":
      await fixCommand(parsed);
      break;

    case "chat":
      await chatCommand(parsed);
      break;

    case "diff":
      await diffCommand(parsed);
      break;

    case "undo":
      await undoCommand(parsed);
      break;

    case "config":
      if (parsed.subcommand === "init") {
        await configInitCommand(parsed);
      } else if (parsed.subcommand === "list-models") {
        await configModelsCommand();
      } else if (parsed.subcommand === "env") {
        await configEnvCommand();
      } else {
        process.stderr.write(`[smallcode] Unknown config subcommand: "${parsed.subcommand ?? ""}"\n`);
        printUsage();
        process.exit(1);
      }
      break;

    case "doctor":
      await doctorCommand(parsed);
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
        const saveTranscripts = flags["save-transcripts"] === true;

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
          saveTranscripts,
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

        // Load config for model/transcriptsDir + the provider runSuite needs.
        let resolvedModel = model ?? "unknown";
        let transcriptsDir = "evals/transcripts";
        let gateCfg: ReturnType<typeof loadConfig>["config"] | null = null;
        try {
          gateCfg = loadConfig(configPath).config;
          if (model === undefined) resolvedModel = gateCfg.activeModel;
          transcriptsDir = gateCfg.eval?.transcriptsDir ?? transcriptsDir;
        } catch {
          // optional
        }
        if (gateCfg === null) {
          process.stderr.write(
            "[smallcode] Error: eval gate needs a config with provider.baseUrl — create smallcode.config.json (e.g. `smallcode config init`).\n",
          );
          process.exit(1);
        }

        const suite = await loadSuite(resolve(suiteDir));
        const result = await runSuite(suite, {
          model: resolvedModel,
          config: gateCfg,
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
