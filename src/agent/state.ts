import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentConfig, AgentState, Goal, TurnRecord } from "./types.ts";

export function getStatePath(config: AgentConfig): string {
  return config.statePath ?? join(config.repoRoot, ".smallcode", "state.json");
}

export function createState(config: AgentConfig, task: string): AgentState {
  const now = Date.now();
  return {
    sessionId: randomUUID(),
    task,
    repoRoot: config.repoRoot,
    modelId: config.modelId,
    goals: [],
    currentGoalIndex: 0,
    turns: [],
    status: "running",
    scratchpad: "",
    startedAt: now,
    updatedAt: now,
    maxTurns: config.maxTurns,
  };
}

export async function saveState(state: AgentState, statePath: string): Promise<void> {
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, statePath);
}

export async function loadState(statePath: string): Promise<AgentState | null> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as AgentState;
  } catch {
    return null;
  }
}

export function addTurn(state: AgentState, turn: TurnRecord): void {
  state.turns.push(turn);
  state.updatedAt = Date.now();
}

export function advanceGoal(state: AgentState): void {
  const goal = state.goals[state.currentGoalIndex];
  if (goal !== undefined) {
    goal.status = "done";
    goal.completedAt = Date.now();
  }
  state.currentGoalIndex += 1;
  state.updatedAt = Date.now();

  // Check if all goals are done
  if (state.currentGoalIndex >= state.goals.length) {
    state.status = "done";
  }
}

export function failGoal(state: AgentState, error: string): void {
  const goal = state.goals[state.currentGoalIndex];
  if (goal !== undefined) {
    goal.status = "failed";
    goal.error = error;
  }
  state.status = "failed";
  state.updatedAt = Date.now();
}

export function isTerminal(state: AgentState): boolean {
  return state.status !== "running";
}

export function currentGoal(state: AgentState): Goal | null {
  const goal = state.goals[state.currentGoalIndex];
  return goal ?? null;
}
