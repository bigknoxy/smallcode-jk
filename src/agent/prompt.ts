import { estimateTokens } from "@/context/tokens.ts";
import type { ContextBundle } from "@/context/types.ts";
import type { ModelProfile } from "@/models/types.ts";
import { renderDiagnostic } from "@/verify/failure-extract.ts";
import { defaultPromptSet } from "./prompt-set.ts";
import type { AgentConfig, AgentState } from "./types.ts";

export interface BuildTurnPromptOpts {
  /** When true, emit a REDRAFT section and suppress Recent History. */
  redraft?: boolean;
  /** Strategy hint appended to the REDRAFT section. */
  strategyHint?: string;
  /**
   * When true, emit an ANSWER-NOW section and suppress Recent History. Set on the
   * turn AFTER a think-only truncation: the model burned its whole generation
   * budget on reasoning and produced no answer. This prompt tells it to skip the
   * thinking and emit the FILE: block / TOOL: call immediately.
   */
  answerNow?: boolean;
}

// Experimental: SMALLCODE_DIFF_EDIT=1 switches PATCH (big-file) mode from
// "re-emit the complete function" to a minimal SEARCH/REPLACE diff. The forensics
// show coder models over-edit when asked for the whole function; a diff of only the
// changed lines fits their natural "show only the change" behaviour. The parser +
// fuzzy applier + repair pipeline already accept SEARCH/REPLACE. Flag-gated so the
// default behaviour is untouched until the A/B confirms it.
const DIFF_EDIT = process.env["SMALLCODE_DIFF_EDIT"] === "1";
// Size gate: the minimal-diff format only pays off on LARGE target functions
// (where whole-function re-emission over-edits). On small functions whole-function
// PATCH already works and exact-match S/R only adds fragility (the edit-reliability
// A/B: wrapText 42ln 0.20→0.60 win; padCell 10ln 0.70→0.10 regression). Apply diff
// only when the target function is at least this many lines.
const DIFF_MIN_FN_LINES = Number(process.env["SMALLCODE_DIFF_MIN_FN"] ?? "30");

export function buildSystemPrompt(_profile: ModelProfile, config: AgentConfig): string {
  // Delegate to promptSet if supplied; otherwise assemble the default set
  // (which preserves the disciplineRules toggle behaviour exactly).
  const ps = config.promptSet ?? defaultPromptSet({ disciplineRules: config.disciplineRules });

  // Append the ## SKILL block when the promptSet carries a non-empty skill string.
  // When skill is absent or empty, the output is byte-identical to the old behaviour.
  let system = ps.skill && ps.skill.trim().length > 0 ? `${ps.system}\n\n## SKILL\n${ps.skill}` : ps.system;
  if (DIFF_EDIT) {
    // Supersede the earlier rule that forbids SEARCH/REPLACE — for PATCH (big-file)
    // mode we now WANT a minimal diff.
    system += `\n\n## EDIT FORMAT OVERRIDE\nWhen the ## Edit Target section shows a SEARCH/REPLACE template, USE it — emit a minimal diff that changes ONLY the buggy line(s) instead of re-emitting the whole function. This supersedes any earlier rule forbidding SEARCH/REPLACE. When the Edit Target shows a FILE: or whole-function PATCH: template instead, follow that as written.`;
  }
  return system;
}

export function buildTurnPrompt(
  state: AgentState,
  context: ContextBundle,
  opts?: BuildTurnPromptOpts,
): string {
  const goal = state.goals[state.currentGoalIndex];
  const turnNumber = state.turns.length + 1;

  const parts: string[] = [];

  parts.push(`## Task`);
  parts.push(state.task);

  parts.push(`\n## Current Action (step ${state.currentGoalIndex + 1}/${state.goals.length})`);
  parts.push(goal !== undefined ? goal.description : "No active goal.");
  parts.push("\nExecute this action NOW with a FILE: block or tool calls. Do not describe — act.");

  // Deterministic edit-format directive. The harness — not the model — decides
  // whole-file vs single-function editing based on the target file's size, and
  // states it explicitly so a small model never has to self-assess "is this file
  // large?" (it reliably gets that wrong). PATCH localizes the edit to one
  // function so the model emits ~15 lines instead of 160 it would truncate.
  const target = context.targetFile;
  if (target) {
    const usePatch = target.format === "patch" && target.functionName !== undefined;
    parts.push(`\n## Edit Target — ${target.path} (${target.lineCount} lines)`);
    const useDiff =
      usePatch && DIFF_EDIT && (target.functionLineCount ?? 0) >= DIFF_MIN_FN_LINES;
    if (useDiff) {
      // Minimal SEARCH/REPLACE diff: change only the buggy lines of the target fn.
      parts.push(
        `This file is large. Make a MINIMAL edit to the \`${target.functionName}\` function: emit a SEARCH/REPLACE block that changes ONLY the buggy line(s). Copy the SEARCH text BYTE-FOR-BYTE from the file shown in Relevant Context below (same indentation — tabs vs spaces — and punctuation). Output it as the FIRST thing in your reply, in exactly this shape — no preamble, no whole-function rewrite:`,
      );
      parts.push("```");
      parts.push(target.path);
      parts.push("<<<<<<< SEARCH");
      parts.push("(the exact current line(s) containing the bug)");
      parts.push("=======");
      parts.push("(the corrected line(s))");
      parts.push(">>>>>>> REPLACE");
      parts.push("```");
      parts.push(
        "Include only the lines that change; add ONE adjacent unchanged line if needed to make the SEARCH unique. Do NOT re-emit the whole function or file.",
      );
    } else if (usePatch) {
      parts.push(
        `This file is large — use PATCH: mode. Do NOT emit the whole file (it will be rejected). Edit ONLY the \`${target.functionName}\` function. Output the PATCH block as the FIRST thing in your reply — do not think out loud, do not restate the task, just emit it in exactly this shape (replace the placeholder with the corrected function body):`,
      );
      parts.push("```");
      parts.push(`PATCH: ${target.path}`);
      parts.push(`FUNCTION: ${target.functionName}`);
      parts.push("```ts");
      parts.push(`export function ${target.functionName}(...) { /* corrected body, signature line included */ }`);
      parts.push("```");
    } else {
      parts.push(
        `Emit the COMPLETE file \`${target.path}\` in a FILE: block — every line, including unchanged ones. The full current contents are in Relevant Context below; copy the unchanged parts exactly.`,
      );
    }
  }

  parts.push(`\n## Turn ${turnNumber}`);

  // Answer-now recovery: the previous turn ran out of generation budget while
  // thinking and emitted no answer. Suppress history (less to read = less to
  // re-think) and demand an immediate action with no reasoning.
  if (opts?.answerNow) {
    parts.push(
      "\n## ANSWER NOW — your previous turn ran out of space while thinking and produced NO answer. Do NOT think this time. Output the FILE: block or TOOL: call as the FIRST line of your response — no <think>, no preamble, no explanation. Keep any reasoning to a single short sentence at most.",
    );
  } else if (opts?.redraft) {
    // Redraft section: suppress recent history, emit strategy hint.
    parts.push(
      "\n## REDRAFT — previous approach is stuck. Ignore prior attempts; re-read the spec and try a DIFFERENT approach.",
    );
    if (opts.strategyHint) {
      parts.push(`Strategy hint: ${opts.strategyHint}`);
    }
  } else {
    // Include last 2 turns of history (suppressed on redraft — dead-end attempts add noise)
    const recentTurns = state.turns.slice(-2);
    if (recentTurns.length > 0) {
      parts.push("\n## Recent History");
      for (const turn of recentTurns) {
        parts.push(`### Turn ${turn.turn} — Goal: ${turn.goalId}`);

        if (turn.applyResults.length > 0) {
          parts.push("**Edit results:**");
          for (const result of turn.applyResults) {
            const icon = result.status === "applied" ? "✓" : "✗";
            const detail = result.error ? ` — ${result.error}` : "";
            parts.push(`  ${icon} ${result.filePath} (${result.status})${detail}`);

            if (result.status !== "applied") {
              parts.push(`  ✗ ${result.filePath} — edit did not apply.`);
              const matchingChunk = context.chunks.find((c) => c.filePath === result.filePath);
              // PATCH-mode recovery must NOT tell the model to re-emit the whole
              // file: on a large file (the only reason we PATCH) the whole-file
              // emission truncates and is rejected, so the failed-edit feedback
              // would itself force the failure loop. Keep the model on the PATCH
              // block for the single target function instead.
              const tgt = context.targetFile;
              const patchRetry =
                tgt?.format === "patch" &&
                tgt.functionName !== undefined &&
                tgt.path === result.filePath;
              if (patchRetry) {
                parts.push(
                  `  Re-emit a PATCH block for ONLY the \`${tgt!.functionName}\` function — do NOT emit the whole file (it will be truncated and rejected). Change the minimal lines to fix the bug; copy every other line of the function unchanged.`,
                );
                if (matchingChunk) {
                  parts.push(`  The file currently contains:`);
                  parts.push("  ```");
                  parts.push(matchingChunk.content);
                  parts.push("  ```");
                }
              } else if (matchingChunk) {
                // Show current file content so the model can re-emit the full file.
                parts.push(`  The file currently contains:`);
                parts.push("  ```");
                parts.push(matchingChunk.content);
                parts.push("  ```");
                parts.push("  Re-emit the COMPLETE corrected file in a FILE: block.");
              }
            }
          }
        }

        if (turn.toolResults.length > 0) {
          parts.push("**Tool results:**");
          for (const tr of turn.toolResults) {
            const icon = tr.success ? "✓" : "✗";
            // Surface enough output that a failing test's expected/received diff is
            // visible — the model needs the concrete failure to self-correct.
            parts.push(`  ${icon} ${tr.name}: ${tr.output.slice(0, 600)}`);
          }
        }
      }
    }
  }

  // Structured failure diagnostic from the most recent failing turn.
  // When a diagnostic is available, render it prominently so the model can
  // act on the specific assertion instead of guessing. Fall back to the raw
  // slice already shown in tool results (no diagnostic → no extra block).
  const lastTurn = state.turns.at(-1);
  if (lastTurn?.diagnostic) {
    parts.push("\n**Failure (fix THIS):**");
    parts.push(renderDiagnostic(lastTurn.diagnostic));
  }

  // Scratchpad
  if (state.scratchpad.trim().length > 0) {
    parts.push("\n## Scratchpad");
    parts.push(state.scratchpad);
  }

  // Relevant context
  if (context.chunks.length > 0) {
    parts.push("\n## Relevant Context");
    for (const chunk of context.chunks) {
      parts.push(`### ${chunk.filePath} (lines ${chunk.startLine}–${chunk.endLine})`);
      parts.push("```");
      parts.push(chunk.content);
      parts.push("```");
    }
  }

  return parts.join("\n");
}

export interface FittedTurnPrompt {
  /** The assembled user-message prompt, guaranteed to fit (best-effort) under hardCap. */
  turnPrompt: string;
  /** Estimated tokens of system + turnPrompt for the returned prompt. */
  estimatedTokens: number;
  /** Number of repo-context chunks dropped to make it fit. */
  droppedChunks: number;
}

/**
 * Build a turn prompt that fits the model's window. Even with a correct repo
 * context budget, a single turn can overflow: the failed-edit path re-dumps a
 * full file into Recent History on top of ## Relevant Context, and token
 * estimation is approximate. This guard re-builds the prompt while dropping the
 * largest repo-context chunk each pass until `estimateTokens(system) +
 * estimateTokens(turnPrompt) <= hardCap`, or no chunks remain.
 *
 * History (the failing-test output and the failed-edit file the model needs to
 * self-correct) is never trimmed — only surplus ## Relevant Context chunks are
 * dropped, since the most task-relevant chunk is preserved longest (largest are
 * shed first). Pure: no I/O, deterministic for a given input.
 */
export function fitTurnPromptToWindow(
  state: AgentState,
  context: ContextBundle,
  systemPrompt: string,
  hardCap: number,
  opts?: BuildTurnPromptOpts,
): FittedTurnPrompt {
  const systemTokens = estimateTokens(systemPrompt);
  const chunks = [...context.chunks];
  let droppedChunks = 0;

  while (true) {
    const turnPrompt = buildTurnPrompt(state, { ...context, chunks }, opts);
    const estimatedTokens = systemTokens + estimateTokens(turnPrompt);

    if (estimatedTokens <= hardCap || chunks.length === 0) {
      return { turnPrompt, estimatedTokens, droppedChunks };
    }

    // Drop the largest remaining NON-pinned chunk and retry. Largest-first sheds
    // the most tokens per pass. Pinned chunks (the target file the model is being
    // asked to edit) are never shed — dropping them would leave the model editing
    // a file it cannot see, the exact failure this guard otherwise causes.
    let largestIdx = -1;
    let largestTokens = -1;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i]?.pinned) continue;
      const t = chunks[i]?.estimatedTokens ?? 0;
      if (t > largestTokens) {
        largestTokens = t;
        largestIdx = i;
      }
    }
    // Only pinned chunks remain — nothing left to shed. Return as-is (the pinned
    // target may exceed hardCap; the provider call surfaces that honestly rather
    // than us silently dropping the one file that matters).
    if (largestIdx === -1) {
      return { turnPrompt, estimatedTokens, droppedChunks };
    }
    chunks.splice(largestIdx, 1);
    droppedChunks++;
  }
}
