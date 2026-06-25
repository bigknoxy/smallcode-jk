/**
 * skill-distiller.ts
 *
 * Offline, template-based distillation of a seed skill from passing session
 * transcripts.  PURE — no model calls, no network I/O.  Deterministic given
 * the same input order.
 *
 * Usage:
 *   import { distillSkill } from "./skill-distiller.ts";
 *   const skill = await distillSkill(passedSessions, { transcriptStore });
 *
 * The returned string is suitable for the `skill` slot on a PromptSet and will
 * be injected as a `## SKILL` block by buildSystemPrompt.
 */

import type { TranscriptStore } from "../eval/transcript-store.ts";
import type { Transcript } from "../eval/types.ts";
import type { SessionLogEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DistillOpts {
  /** The TranscriptStore used to load turn-level data for each session. */
  transcriptStore: TranscriptStore;
  /**
   * Max number of passing sessions to read.  Defaults to 20.
   * Caps token cost when the log is large.
   */
  maxSessions?: number;
}

/**
 * Read passing transcripts and emit a concise, repo-agnostic playbook block.
 * The output is deterministic: same inputs → same string.
 * Returns a stub string when there are no passing sessions.
 */
export async function distillSkill(
  sessions: SessionLogEntry[],
  opts: DistillOpts,
): Promise<string> {
  const cap = opts.maxSessions ?? 20;

  // Work on the first `cap` entries only (caller is expected to pass newest-first).
  const capped = sessions.slice(0, cap);

  if (capped.length === 0) {
    return "No passing sessions yet — skill empty.";
  }

  // Tally signals across all loaded transcripts.
  const toolSequences: string[][] = [];
  let fileEditCount = 0;
  let patchEditCount = 0;
  const runCommandSet = new Set<string>();
  let stallRecoveryCount = 0;
  let totalTranscripts = 0;

  for (const entry of capped) {
    // Derive transcript ID: the session log stores the transcript file path.
    // The TranscriptStore.load() takes the transcript *id* (filename without
    // extension), not the full path.  Extract it from the path.
    const transcriptId = extractTranscriptId(entry.transcriptPath);
    if (transcriptId === null) continue;

    const transcript: Transcript | null = await opts.transcriptStore.load(transcriptId);
    if (transcript === null) continue;

    totalTranscripts++;

    // Collect tool sequence for this transcript.
    const toolSeq: string[] = [];
    for (const turn of transcript.turns) {
      // Track edit format used.
      for (const eb of turn.editBlocks) {
        if (eb.format === "patch-function") {
          patchEditCount++;
        } else {
          // "full-file", "search-replace", "json" all count as file edits.
          fileEditCount++;
        }
      }

      // Track tool calls.
      for (const tc of turn.toolCalls) {
        toolSeq.push(tc.name);
        if (tc.name === "run_command" && typeof tc.args["cmd"] === "string") {
          runCommandSet.add(tc.args["cmd"] as string);
        }
      }

      // Track redraft/stall recovery.
      if (turn.redrafted) {
        stallRecoveryCount++;
      }
    }
    if (toolSeq.length > 0) {
      toolSequences.push(toolSeq);
    }
  }

  if (totalTranscripts === 0) {
    return "No passing sessions yet — skill empty.";
  }

  // ---------------------------------------------------------------------------
  // Build the playbook from tallied signals.
  // ---------------------------------------------------------------------------

  const lines: string[] = [];
  lines.push(`Distilled from ${totalTranscripts} passing session(s).\n`);
  lines.push("- Start with `read_file` to understand the current structure before editing.");

  // Edit format recommendation.
  const totalEdits = fileEditCount + patchEditCount;
  if (totalEdits > 0) {
    const patchPct = Math.round((patchEditCount / totalEdits) * 100);
    if (patchPct >= 70) {
      lines.push("- Prefer PATCH: format for large files (> 300 lines); it was used in the majority of successful edits.");
    } else {
      lines.push("- Use FILE: full-file edits as the primary format; emit the complete file every time.");
    }
  } else {
    lines.push("- Use FILE: full-file edits as the primary format; emit the complete file every time.");
  }

  // Dominant tool sequence pattern.
  const pattern = dominantToolPattern(toolSequences);
  if (pattern.length > 0) {
    lines.push(`- Common winning tool sequence: ${pattern.join(" → ")}.`);
  }

  // Common run_command commands (deduped, sorted).
  const cmds = Array.from(runCommandSet).sort();
  if (cmds.length > 0) {
    lines.push(`- Common commands used on passing runs: ${cmds.map((c) => `\`${c}\``).join(", ")}.`);
  }

  // Stall recovery note.
  if (stallRecoveryCount > 0) {
    lines.push(
      "- When stuck, try a completely different approach (redraft): re-read the spec, avoid the previous strategy.",
    );
  }

  // Always append finish reminder.
  lines.push("- Always call `TOOL: run_tests {}` after edits, then `TOOL: finish` when tests pass.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the transcript ID (basename without extension) from a stored path.
 * The SessionLogger records the full path passed in at log time.
 * e.g. "/evals/transcripts/task-1/abc123.json" → "abc123"
 * Returns null when the path can't be parsed into a usable ID.
 */
function extractTranscriptId(transcriptPath: string): string | null {
  if (!transcriptPath || transcriptPath.trim() === "") return null;
  // Use string ops instead of path module: basename without ext.
  const parts = transcriptPath.replace(/\\/g, "/").split("/");
  const filename = parts[parts.length - 1];
  if (!filename) return null;
  const dotIdx = filename.lastIndexOf(".");
  return dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
}

/**
 * Find the most common tool name that appears in the majority of sequences.
 * Returns a representative ordered list (first-occurrence order from the most
 * common sequence by length).  Deterministic: sequences are compared by join().
 */
function dominantToolPattern(sequences: string[][]): string[] {
  if (sequences.length === 0) return [];

  // Count frequency of each unique joined sequence.
  const freq = new Map<string, number>();
  for (const seq of sequences) {
    const key = seq.join(",");
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }

  // Pick the most frequent (ties broken by shorter length, then lexicographic).
  let bestKey = "";
  let bestCount = 0;
  for (const [key, count] of freq) {
    if (
      count > bestCount ||
      (count === bestCount && key.split(",").length < bestKey.split(",").length) ||
      (count === bestCount &&
        key.split(",").length === bestKey.split(",").length &&
        key < bestKey)
    ) {
      bestKey = key;
      bestCount = count;
    }
  }

  if (!bestKey) return [];

  // Return the unique tool names in order of first appearance (deduplicated).
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of bestKey.split(",")) {
    if (!seen.has(tool)) {
      seen.add(tool);
      result.push(tool);
    }
  }
  return result;
}
