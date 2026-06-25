#!/usr/bin/env bun
/**
 * distill-skill.ts
 *
 * Offline CLI that reads passing sessions from the session log and distills a
 * seed skill from their transcripts.  No model calls — purely template-based.
 *
 * Usage:
 *   bun scripts/distill-skill.ts [--log <path>] [--transcripts <dir>] [--out <path>] [--max <n>]
 *
 * Options:
 *   --log <path>          Path to sessions.jsonl (default: evals/sessions.jsonl)
 *   --transcripts <dir>   Transcripts directory    (default: evals/transcripts)
 *   --out <path>          Write skill to file instead of stdout
 *   --max <n>             Max passing sessions to read (default: 20)
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error or unexpected failure
 *
 * Idempotent: running twice with the same log produces the same output.
 * No side effects beyond the optional --out file.
 */

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TranscriptStore } from "../src/eval/transcript-store.ts";
import { SessionLogger } from "../src/improve/session-logger.ts";
import { distillSkill } from "../src/improve/skill-distiller.ts";

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  const PROJECT_ROOT = resolve(import.meta.dir, "..");

  // Parse CLI args.
  const args = process.argv.slice(2);
  const flags = parseFlags(args);

  const logPath = flags["log"] ?? join(PROJECT_ROOT, "evals", "sessions.jsonl");
  const transcriptsDir = flags["transcripts"] ?? join(PROJECT_ROOT, "evals", "transcripts");
  const outPath: string | undefined = flags["out"];
  const maxSessions = flags["max"] !== undefined ? parseInt(flags["max"], 10) : 20;

  if (Number.isNaN(maxSessions) || maxSessions < 1) {
    process.stderr.write("[distill-skill] Error: --max must be a positive integer\n");
    process.exit(1);
  }

  const transcriptStore = new TranscriptStore(transcriptsDir);
  const logger = new SessionLogger(logPath, transcriptStore);

  const passedSessions = await logger.getPassedSessions(maxSessions);

  const skill = await distillSkill(passedSessions, { transcriptStore, maxSessions });

  if (outPath !== undefined) {
    await writeFile(resolve(outPath), skill, { encoding: "utf-8" });
    process.stdout.write(`[distill-skill] Skill written to ${outPath}\n`);
  } else {
    process.stdout.write(skill + "\n");
  }
}

// ---------------------------------------------------------------------------
// Minimal flag parser — no dependencies
// ---------------------------------------------------------------------------

function parseFlags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== undefined && arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}
