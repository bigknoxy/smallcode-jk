import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvalRunResult } from "../eval/types.ts";
import type { MetricsHistory, MetricsSnapshot } from "./types.ts";

export class MetricsStore {
  constructor(private readonly storePath: string) {}

  async append(result: EvalRunResult, now: number): Promise<void> {
    try {
      const snapshot: MetricsSnapshot = {
        timestamp: now,
        runId: result.runId,
        suiteId: result.suiteId,
        modelId: result.modelId,
        overallPassAt1: result.overallPassAt1,
        totalTasksPassed: result.totalTasksPassed,
        totalTasks: result.taskResults.length,
        perTaskPassAt1: Object.fromEntries(result.taskResults.map((t) => [t.task.id, t.passAt1])),
      };

      const line = `${JSON.stringify(snapshot)}\n`;

      await mkdir(dirname(this.storePath), { recursive: true });

      // Atomic append: read existing content, append line, write back
      let existing = "";
      try {
        existing = await readFile(this.storePath, "utf-8");
      } catch {
        // File does not exist yet — start fresh
      }

      await writeFile(this.storePath, existing + line, {
        encoding: "utf-8",
        mode: 0o600,
      });

      await chmod(this.storePath, 0o600);
    } catch (err) {
      console.warn("[MetricsStore] Failed to append snapshot:", err);
    }
  }

  async getHistory(suiteId: string): Promise<MetricsHistory> {
    const snapshots = await this.query(suiteId);
    return { suiteId, snapshots };
  }

  async getLatest(suiteId: string): Promise<MetricsSnapshot | null> {
    const snapshots = await this.query(suiteId);
    if (snapshots.length === 0) return null;
    // snapshots are in file order (ascending time); return last
    return snapshots[snapshots.length - 1] ?? null;
  }

  async getAllSuiteIds(): Promise<string[]> {
    const all = await this._readAll();
    const ids = new Set<string>();
    for (const s of all) {
      ids.add(s.suiteId);
    }
    return Array.from(ids);
  }

  async query(suiteId: string, since?: number): Promise<MetricsSnapshot[]> {
    const all = await this._readAll();
    return all.filter((s) => s.suiteId === suiteId && (since === undefined || s.timestamp > since));
  }

  private async _readAll(): Promise<MetricsSnapshot[]> {
    let raw: string;
    try {
      raw = await readFile(this.storePath, "utf-8");
    } catch {
      return [];
    }

    const results: MetricsSnapshot[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) {
          results.push(parsed as MetricsSnapshot);
        }
      } catch {
        // Skip corrupt lines
      }
    }
    return results;
  }
}
