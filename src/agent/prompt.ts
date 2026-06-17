import type { ContextBundle } from "@/context/types.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { AgentConfig, AgentState } from "./types.ts";

export function buildSystemPrompt(_profile: ModelProfile, _config: AgentConfig): string {
  return `You are smallcode, an autonomous coding assistant running on a small local model.
Work through the task one sub-goal at a time. Be precise and minimal.

## Edit format
To modify files, use ONLY this exact format:
<file path>
<<<<<<< SEARCH
<exact existing code to replace>
=======
<new code>
>>>>>>> REPLACE

## Tools
To read a file:   TOOL: read_file {"path": "src/foo.ts"}
To run a command: TOOL: run_command {"cmd": "bun test"}
To run tests:     TOOL: run_tests {}
To finish a goal: TOOL: finish {"summary": "what was done"}

## Rules
- Complete ONE sub-goal per response, then call TOOL: finish
- Never modify files you haven't read first
- Always run tests after editing code
- Keep responses focused and short`;
}

export function buildTurnPrompt(state: AgentState, context: ContextBundle): string {
  const goal = state.goals[state.currentGoalIndex];
  const turnNumber = state.turns.length + 1;

  const parts: string[] = [];

  parts.push(`## Current Goal (${state.currentGoalIndex + 1}/${state.goals.length})`);
  parts.push(goal !== undefined ? goal.description : "No active goal.");

  parts.push(`\n## Turn ${turnNumber}`);
  parts.push(`Task: ${state.task}`);

  // Include last 2 turns of history
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
        }
      }

      if (turn.toolResults.length > 0) {
        parts.push("**Tool results:**");
        for (const tr of turn.toolResults) {
          const icon = tr.success ? "✓" : "✗";
          parts.push(`  ${icon} ${tr.name}: ${tr.output.slice(0, 300)}`);
        }
      }
    }
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
