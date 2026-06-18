import type { ContextBundle } from "@/context/types.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { AgentConfig, AgentState } from "./types.ts";

export function buildSystemPrompt(_profile: ModelProfile, _config: AgentConfig): string {
  return `You are smallcode, a coding assistant. Edit files to complete coding tasks.

## HOW TO EDIT A FILE

Output the file path on one line, then a SEARCH/REPLACE block:

src/math.ts
<<<<<<< SEARCH
export function add(a: number, b: number): number {
  // TODO: implement
  return 0;
}
=======
export function add(a: number, b: number): number {
  return a + b;
}
>>>>>>> REPLACE

Then run tests and finish:
TOOL: run_tests {}
TOOL: finish {"summary": "implemented add()"}

## HOW TO USE TOOLS

Read a file:      TOOL: read_file {"path": "src/foo.ts"}
Run tests:        TOOL: run_tests {}
Run a command:    TOOL: run_command {"cmd": "bun test"}
Finish a goal:    TOOL: finish {"summary": "what was done"}

## RULES

1. Output edit blocks IMMEDIATELY — do not describe what you will do, just do it.
2. The SEARCH text must EXACTLY match existing code (whitespace matters).
3. After editing, always call TOOL: run_tests {} to verify.
4. After tests pass, call TOOL: finish {"summary": "..."}.
5. If no change is needed, call TOOL: finish {"summary": "no changes needed"}.
6. Do NOT output numbered lists of steps. Output edit blocks and tool calls only.`;
}

export function buildTurnPrompt(state: AgentState, context: ContextBundle): string {
  const goal = state.goals[state.currentGoalIndex];
  const turnNumber = state.turns.length + 1;

  const parts: string[] = [];

  parts.push(`## Task`);
  parts.push(state.task);

  parts.push(`\n## Current Action (step ${state.currentGoalIndex + 1}/${state.goals.length})`);
  parts.push(goal !== undefined ? goal.description : "No active goal.");
  parts.push("\nExecute this action NOW using edit blocks or tool calls. Do not describe — act.");

  parts.push(`\n## Turn ${turnNumber}`);

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
