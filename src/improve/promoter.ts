import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CandidateTask } from "./types.ts";

export async function promoteToSuite(candidate: CandidateTask, suiteDir: string): Promise<string> {
  await mkdir(suiteDir, { recursive: true });

  const filePath = resolve(join(suiteDir, `${candidate.task.id}.json`));
  const tmpPath = `${filePath}.tmp`;

  await writeFile(tmpPath, JSON.stringify(candidate.task, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmpPath, filePath);

  return filePath;
}

export async function listCandidates(candidateDir: string): Promise<CandidateTask[]> {
  let files: string[];
  try {
    const entries = await readdir(candidateDir);
    files = entries.filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const candidates: CandidateTask[] = [];

  for (const file of files) {
    const filePath = join(candidateDir, file);
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        candidates.push(parsed as CandidateTask);
      }
    } catch {
      // Skip corrupt files
    }
  }

  // Sort by promotedAt descending (newest first)
  candidates.sort((a, b) => b.promotedAt - a.promotedAt);

  return candidates;
}
