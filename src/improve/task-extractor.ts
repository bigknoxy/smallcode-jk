import type { AgentState, TurnRecord } from "../agent/types.ts";
import type { GraderConfig } from "../eval/types.ts";
import type { CandidateTask, SessionLogEntry } from "./types.ts";

export interface ExtractOptions {
  taskIdPrefix?: string; // default: "promoted"
  tags?: string[]; // default: ["promoted", "needs-review"]
}

function buildGraders(lastTurn: TurnRecord | undefined): GraderConfig[] {
  if (lastTurn === undefined) {
    return [{ type: "static_analysis", commands: ["biome", "tsc"] }];
  }

  const graders: GraderConfig[] = [];

  // Check for failed run_tests
  const hasFailedTests = lastTurn.toolResults.some((r) => r.name === "run_tests" && !r.success);

  // Check for run_command that ran tsc/biome
  const hasStaticCheck = lastTurn.toolResults.some((r) => {
    if (r.name !== "run_command") return false;
    const args = lastTurn.toolCalls.find((c) => c.name === "run_command")?.args;
    if (!args) return false;
    const cmd = typeof args["command"] === "string" ? args["command"] : "";
    return cmd.includes("tsc") || cmd.includes("biome");
  });

  if (hasFailedTests) {
    graders.push({ type: "deterministic_tests", required: [] });
  }

  if (hasStaticCheck) {
    graders.push({ type: "static_analysis", commands: ["biome", "tsc"] });
  }

  if (graders.length === 0) {
    graders.push({ type: "static_analysis", commands: ["biome", "tsc"] });
  }

  return graders;
}

function getLastToolError(lastTurn: TurnRecord | undefined): string {
  if (lastTurn === undefined) return "no turns recorded";
  const failed = lastTurn.toolResults.filter((r) => !r.success);
  if (failed.length > 0) {
    const f = failed[failed.length - 1];
    if (f === undefined) return "unknown tool error";
    return f.error ?? f.output.slice(0, 200);
  }
  return "unknown failure";
}

export function extractTaskFromSession(
  entry: SessionLogEntry,
  state: AgentState,
  opts?: ExtractOptions,
): CandidateTask {
  const prefix = opts?.taskIdPrefix ?? "promoted";
  const tags = opts?.tags ?? ["promoted", "needs-review"];

  const shortId = entry.sessionId.slice(0, 8);
  const taskId = `${prefix}-${shortId}`;

  const lastTurn: TurnRecord | undefined = state.turns[state.turns.length - 1];
  const graders = buildGraders(lastTurn);
  const lastError = getLastToolError(lastTurn);

  const candidate: CandidateTask = {
    id: taskId,
    sourceSessionId: entry.sessionId,
    sourceTranscriptPath: entry.transcriptPath,
    task: {
      id: taskId,
      desc: state.task,
      setup: {
        files: {},
      },
      graders,
      trackedMetrics: ["n_turns", "n_toolcalls", "n_total_tokens", "pass_at_1"],
      tags,
    },
    promotedAt: Date.now(),
    notes: `Session failed after ${entry.nTurns} turns: ${lastError}`,
  };

  return candidate;
}
