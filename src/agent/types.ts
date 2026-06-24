import type { ApplyResult, EditBlock } from "../edit/types.ts";

export type GoalStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";
export type SessionStatus = "running" | "done" | "failed" | "max_turns" | "abandoned";
export type ToolName =
  | "read_file"
  | "write_file"
  | "run_command"
  | "run_tests"
  | "finish"
  | "think";

export interface Goal {
  id: string;
  description: string;
  status: GoalStatus;
  completedAt?: number;
  error?: string;
}

export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: ToolName;
  success: boolean;
  output: string;
  error?: string;
  durationMs?: number;
}

export interface TurnRecord {
  turn: number;
  goalId: string;
  prompt: string;
  rawResponse: string;
  reasoning?: string; // extracted from <think> tags
  answer: string; // response with reasoning stripped
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  editBlocks: EditBlock[];
  applyResults: ApplyResult[];
  promptTokens: number;
  completionTokens: number;
  timestamp: number;
}

export interface AgentState {
  sessionId: string;
  task: string;
  repoRoot: string;
  modelId: string;
  goals: Goal[];
  currentGoalIndex: number;
  turns: TurnRecord[];
  status: SessionStatus;
  scratchpad: string; // free-form notes the model can read/write
  startedAt: number;
  updatedAt: number;
  maxTurns: number;
}

export interface Candidate {
  index: number;
  rawResponse: string;
  reasoning?: string;
  answer: string;
  editBlocks: EditBlock[];
  applyResults: ApplyResult[];
  checksRun: number;
  checksPassed: number;
  verifierScore: number; // 0–1, fraction of checks passed
}

export interface BestOfNResult {
  winner: Candidate;
  all: Candidate[];
  n: number;
}

export interface AgentConfig {
  repoRoot: string;
  modelId: string;
  maxTurns: number;
  bestOfN: number;
  statePath?: string; // where to persist AgentState JSON; default: <repoRoot>/.smallcode/state.json
  allowedCommands?: string[]; // allowlist for run_command sandbox
  requireApproval?: boolean; // gate destructive actions behind user approval
  disciplineRules?: boolean; // include Karpathy-style discipline rules in system prompt (default: true)
  preSolveReflection?: boolean; // planner briefly reflects before decomposing goals (default: false)
}
