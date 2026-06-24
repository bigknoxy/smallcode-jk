import type { ContextBundle } from "@/context/types.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { AgentConfig, AgentState } from "./types.ts";

const DISCIPLINE_RULES = `

## DISCIPLINE

8. Write MINIMUM code that solves the task — no speculative features, no abstractions for single-use code, no error handling for impossible cases.
9. Change ONLY what the task requires. Do NOT rewrite, reformat, or "improve" unrelated lines; preserve existing code and style exactly.
10. "Minimal" means the CHANGE is small — still emit the WHOLE file as required above.`;

export function buildSystemPrompt(_profile: ModelProfile, config: AgentConfig): string {
  // disciplineRules defaults to true when not explicitly set
  const includeDiscipline = config.disciplineRules !== false;

  return `You are smallcode, a coding assistant. Edit files to complete coding tasks.

## HOW TO EDIT A FILE

Write \`FILE:\` then the path, then a fenced code block containing the COMPLETE
corrected file. Always output the WHOLE file, not a snippet — include every
line, even unchanged ones.

FILE: src/math.ts
\`\`\`ts
export function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

Then run tests and finish:
TOOL: run_tests {}
TOOL: finish {"summary": "implemented add()"}

## HOW TO USE TOOLS

Read a file:      TOOL: read_file {"path": "src/foo.ts"}
Run tests:        TOOL: run_tests {}
Run a command:    TOOL: run_command {"cmd": "bun test"}
Finish a goal:    TOOL: finish {"summary": "what was done"}

For large files (>300 lines), the system may recommend using PATCH: format — see PATCH: below.

## HOW TO PATCH A LARGE FILE (optional, only when recommended)

PATCH: src/foo.ts
FUNCTION: functionName
\`\`\`ts
<complete replacement of just that function, including its signature line>
\`\`\`

Use PATCH: only when explicitly told the file is large. Default to FILE: for all other edits.

## RULES

1. Output the FILE: block IMMEDIATELY — do not describe what you will do, just do it.
2. Always emit the ENTIRE file inside the fence, keeping all existing code that
   should stay. Do NOT use SEARCH/REPLACE markers, diffs, or "...". Just the full file.
3. Copy the unchanged parts EXACTLY from the file shown in "Relevant Context" above.
4. After editing, call TOOL: run_tests {} to verify.
5. After tests pass, call TOOL: finish {"summary": "..."}.
6. If no change is needed, call TOOL: finish {"summary": "no changes needed"} with NO FILE: block.
7. Do NOT output numbered lists of steps. Output the FILE: block and tool calls only.${includeDiscipline ? DISCIPLINE_RULES : ""}

## EXAMPLE: fixing a bug

Relevant Context shows:
  export async function getValue(): Promise<number> {
    const v = fetchValue();          // BUG: missing await
    return (v as unknown as number);
  }

Your response — the whole file, fixed:

FILE: src/async-utils.ts
\`\`\`ts
export async function getValue(): Promise<number> {
  const v = await fetchValue();
  return v;
}
\`\`\`
TOOL: run_tests {}
TOOL: finish {"summary": "awaited fetchValue"}`;
}

export function buildTurnPrompt(state: AgentState, context: ContextBundle): string {
  const goal = state.goals[state.currentGoalIndex];
  const turnNumber = state.turns.length + 1;

  const parts: string[] = [];

  parts.push(`## Task`);
  parts.push(state.task);

  parts.push(`\n## Current Action (step ${state.currentGoalIndex + 1}/${state.goals.length})`);
  parts.push(goal !== undefined ? goal.description : "No active goal.");
  parts.push("\nExecute this action NOW with a FILE: block or tool calls. Do not describe — act.");

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
