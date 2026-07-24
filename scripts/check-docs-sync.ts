#!/usr/bin/env bun
// E5-T3 — docs-drift check. Fails when a SMALLCODE_* env flag or a CLI subcommand
// exists in code but isn't documented in README.md + docs/llms.html (or vice
// versa). Enforces the HARD no-drift rule mechanically for the structured
// surfaces. Run: `bun scripts/check-docs-sync.ts` (add `--warn` to never exit 1).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_REGISTRY } from "../src/config/env.ts";
import { checkDocsSync, extractCommands, renderDocsSync } from "../src/eval/docs-sync.ts";

const ROOT = join(import.meta.dir, "..");
const WARN_ONLY = process.argv.includes("--warn");

const envNames = ENV_REGISTRY.map((e) => e.name);
const commands = extractCommands(readFileSync(join(ROOT, "bin/smallcode.ts"), "utf-8"));

const docs = {
  "README.md": readFileSync(join(ROOT, "README.md"), "utf-8"),
  "docs/llms.html": readFileSync(join(ROOT, "docs/llms.html"), "utf-8"),
};

const report = checkDocsSync(envNames, commands, docs);
for (const line of renderDocsSync(report)) console.log(line);
console.log(
  `\n[check-docs-sync] ${envNames.length} env flag(s) + ${commands.length} command(s) checked against ${Object.keys(docs).length} doc file(s).`,
);

if (!report.ok && !WARN_ONLY) process.exit(1);
