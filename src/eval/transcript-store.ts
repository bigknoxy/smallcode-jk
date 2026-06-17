import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Transcript } from "./types.ts";

export class TranscriptStore {
  constructor(private readonly dir: string) {}

  async save(transcript: Transcript): Promise<void> {
    const taskDir = join(this.dir, transcript.taskId);
    await mkdir(taskDir, { recursive: true });

    const filePath = join(taskDir, `${transcript.id}.json`);
    const tmpPath = `${filePath}.tmp`;

    await writeFile(tmpPath, JSON.stringify(transcript, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tmpPath, filePath);
  }

  async load(id: string): Promise<Transcript | null> {
    // Search all task subdirectories for the transcript id
    let taskDirs: string[];
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      taskDirs = entries.filter((e) => e.isDirectory()).map((e) => join(this.dir, e.name));
    } catch {
      return null;
    }

    for (const taskDir of taskDirs) {
      const filePath = join(taskDir, `${id}.json`);
      try {
        const raw = await readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return null;
        return parsed as Transcript;
      } catch {
        // Not in this dir or corrupt — continue
      }
    }

    return null;
  }

  async list(taskId?: string): Promise<
    Array<{
      id: string;
      taskId: string;
      trialIndex: number;
      outcome: string;
      startedAt: number;
    }>
  > {
    const results: Array<{
      id: string;
      taskId: string;
      trialIndex: number;
      outcome: string;
      startedAt: number;
    }> = [];

    let taskDirs: Array<{ name: string; path: string }>;
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      taskDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: join(this.dir, e.name) }));
    } catch {
      return results;
    }

    // Filter by taskId if provided
    if (taskId !== undefined) {
      taskDirs = taskDirs.filter((d) => d.name === taskId);
    }

    for (const taskDir of taskDirs) {
      let files: string[];
      try {
        const entries = await readdir(taskDir.path);
        files = entries.filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(taskDir.path, file);
        try {
          const raw = await readFile(filePath, "utf-8");
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null) continue;
          const t = parsed as Record<string, unknown>;

          const id = typeof t["id"] === "string" ? t["id"] : "";
          const tTaskId = typeof t["taskId"] === "string" ? t["taskId"] : taskDir.name;
          const trialIndex = typeof t["trialIndex"] === "number" ? t["trialIndex"] : 0;
          const outcome = typeof t["outcome"] === "string" ? t["outcome"] : "unknown";
          const startedAt = typeof t["startedAt"] === "number" ? t["startedAt"] : 0;

          if (id === "") continue;

          results.push({ id, taskId: tTaskId, trialIndex, outcome, startedAt });
        } catch {
          // Corrupt file — skip
        }
      }
    }

    return results;
  }

  async loadAll(taskId?: string): Promise<Transcript[]> {
    const metas = await this.list(taskId);
    const transcripts: Transcript[] = [];

    for (const meta of metas) {
      const t = await this.load(meta.id);
      if (t !== null) {
        transcripts.push(t);
      }
    }

    return transcripts;
  }
}
