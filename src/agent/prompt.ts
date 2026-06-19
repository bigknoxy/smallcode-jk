import type { ContextBundle } from "@/context/types.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { AgentConfig, AgentState } from "./types.ts";

export function buildSystemPrompt(_profile: ModelProfile, _config: AgentConfig): string {
  return `You are smallcode, a coding assistant. Edit files to complete coding tasks.

**IMPORTANT: Output the edit block immediately. Do NOT write long reasoning. Be terse.**

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
6. Do NOT output numbered lists of steps. Output edit blocks and tool calls only.
7. The SEARCH text must be COPIED EXACTLY from the file shown in "Relevant Context" above.
   If the edit fails, read the context again and copy the exact text.
8. Keep your <think> block brief — 2-3 sentences max. Spend tokens on the edit, not reasoning.

## EXAMPLE: edit failed and retry

If your edit fails, retry with text copied exactly from the file:

Turn 2 result:
✗ src/math.ts (not_found) — Your SEARCH block did not match the file.

Turn 3 — retry with exact SEARCH:
src/math.ts
<<<<<<< SEARCH
function add(a, b) {
=======
function add(a: number, b: number): number {
  return a + b;
}
>>>>>>> REPLACE`;
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

          if (result.status !== "applied") {
            parts.push(`  ✗ ${result.filePath} — Your SEARCH block did not match the file.`);
            // Find the file content in context chunks so the model can copy exact text
            const matchingChunk = context.chunks.find((c) => c.filePath === result.filePath);
            if (matchingChunk) {
              parts.push(`  The file currently contains:`);
              parts.push("  ```");
              parts.push(matchingChunk.content);
              parts.push("  ```");
              parts.push("  Rewrite your SEARCH block to EXACTLY match these lines.");
            }
          }
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
