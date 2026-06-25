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
}

export function buildSystemPrompt(_profile: ModelProfile, config: AgentConfig): string {
  // Delegate to promptSet if supplied; otherwise assemble the default set
  // (which preserves the disciplineRules toggle behaviour exactly).
  const ps = config.promptSet ?? defaultPromptSet({ disciplineRules: config.disciplineRules });

  // Append the ## SKILL block when the promptSet carries a non-empty skill string.
  // When skill is absent or empty, the output is byte-identical to the old behaviour.
  if (ps.skill && ps.skill.trim().length > 0) {
    return `${ps.system}\n\n## SKILL\n${ps.skill}`;
  }
  return ps.system;
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

  parts.push(`\n## Turn ${turnNumber}`);

  // Redraft section: suppress recent history, emit strategy hint.
  if (opts?.redraft) {
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
              // Show current file content so the model can re-emit the full file.
              const matchingChunk = context.chunks.find((c) => c.filePath === result.filePath);
              if (matchingChunk) {
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
