import os from "node:os";
import type { AgentState, Goal } from "../agent/types.ts";

const EOL = os.EOL;
const PREFIX = "[smallcode]";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function argsSnippet(args: Record<string, unknown>): string {
  return truncate(JSON.stringify(args), 80);
}

export class ProgressDisplay {
  constructor(private readonly stream: NodeJS.WriteStream = process.stderr) {}

  private write(line: string): void {
    this.stream.write(line + EOL);
  }

  showGoals(goals: Goal[]): void {
    this.write(`${PREFIX} Goals:`);
    for (let i = 0; i < goals.length; i++) {
      const goal = goals[i];
      if (goal === undefined) continue;
      this.write(`  ${i + 1}. ${goal.description}`);
    }
    this.write("");
  }

  showTurnStart(turn: number, maxTurns: number, goalDesc: string): void {
    this.write(`${PREFIX} Turn ${turn}/${maxTurns} — Goal: ${goalDesc}`);
  }

  showToolCall(name: string, args: Record<string, unknown>): void {
    this.write(`  → ${name}(${argsSnippet(args)}) ✓`);
  }

  showToolResult(name: string, success: boolean, outputSnippet: string): void {
    const mark = success ? "✓" : "✗";
    const snippet = truncate(outputSnippet, 60);
    this.write(`  → ${name} ${mark} ${snippet}`);
  }

  showEditApplied(filePath: string, status: string): void {
    this.write(`  EDIT ${filePath} — ${status}`);
  }

  showVerifyResult(passed: boolean, summary: string): void {
    const mark = passed ? "✓" : "✗";
    this.write(`  verify ${mark} ${truncate(summary, 60)}`);
  }

  showComplete(state: AgentState): void {
    const turns = state.turns.length;
    const tokens = state.turns.reduce((sum, t) => sum + t.promptTokens + t.completionTokens, 0);
    const durationMs = state.updatedAt - state.startedAt;
    const durationSec = (durationMs / 1000).toFixed(1);
    this.write(
      `${PREFIX} ✓ Done in ${turns} turn${turns === 1 ? "" : "s"} | ${tokens} tokens | ${durationSec}s`,
    );
  }

  showError(msg: string): void {
    this.write(`${PREFIX} ✗ Error: ${msg}`);
  }
}
