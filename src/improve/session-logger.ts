import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentState } from "../agent/types.ts";
import type { TranscriptStore } from "../eval/transcript-store.ts";
import type { SessionLogEntry } from "./types.ts";

export class SessionLogger {
  private readonly _transcriptStore: TranscriptStore;
  private readonly logPath: string;

  constructor(logPath: string, transcriptStore: TranscriptStore) {
    this.logPath = logPath;
    this._transcriptStore = transcriptStore;
  }

  // Expose store for subclasses or future cross-linking extensions
  protected get transcriptStore(): TranscriptStore {
    return this._transcriptStore;
  }

  async logSession(state: AgentState, transcriptPath: string): Promise<void> {
    try {
      const nTokens = state.turns.reduce((sum, t) => sum + t.promptTokens + t.completionTokens, 0);

      const entry: SessionLogEntry = {
        sessionId: state.sessionId,
        taskDesc: state.task,
        repoRoot: state.repoRoot,
        modelId: state.modelId,
        outcome: state.status as SessionLogEntry["outcome"],
        nTurns: state.turns.length,
        nTokens,
        latencyMs: state.updatedAt - state.startedAt,
        transcriptPath,
        timestamp: Date.now(),
      };

      const line = `${JSON.stringify(entry)}\n`;

      // Ensure parent directory exists
      await mkdir(dirname(this.logPath), { recursive: true });

      await appendFile(this.logPath, line, { encoding: "utf-8", mode: 0o600 });

      // Ensure mode is 0o600 even if file already existed before
      await chmod(this.logPath, 0o600);
    } catch (err) {
      console.warn("[SessionLogger] Failed to log session:", err);
    }
  }

  async readLog(): Promise<SessionLogEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.logPath, "utf-8");
    } catch {
      return [];
    }

    const entries: SessionLogEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) {
          entries.push(parsed as SessionLogEntry);
        }
      } catch {
        // Skip corrupt line
      }
    }

    // Newest-first (reverse line order)
    return entries.reverse();
  }

  async getFailedSessions(limit?: number): Promise<SessionLogEntry[]> {
    const all = await this.readLog();
    const failed = all.filter((e) => e.outcome === "failed" || e.outcome === "max_turns");
    if (limit !== undefined) {
      return failed.slice(0, limit);
    }
    return failed;
  }

  async getPassedSessions(limit?: number): Promise<SessionLogEntry[]> {
    const all = await this.readLog();
    const passed = all.filter((e) => e.outcome === "done");
    if (limit !== undefined) {
      return passed.slice(0, limit);
    }
    return passed;
  }
}
