import { randomUUID } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EvalTask } from "./types.ts";

export interface TrialEnv {
  dir: string; // absolute path to isolated temp dir
  cleanup: () => Promise<void>;
}

export async function createTrialEnv(task: EvalTask, fixturesRoot: string): Promise<TrialEnv> {
  const dir = join(tmpdir(), `smallcode-eval-${randomUUID()}`);
  await mkdir(dir, { recursive: true });

  // Copy repo fixture if specified
  if (task.setup.repoFixture !== undefined) {
    const fixtureSrc = join(fixturesRoot, task.setup.repoFixture);
    await cp(fixtureSrc, dir, { recursive: true });
  }

  // Write inline files if specified
  if (task.setup.files !== undefined) {
    for (const [relPath, content] of Object.entries(task.setup.files)) {
      const abs = join(dir, relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }
  }

  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}

export async function applyReferenceSolution(
  task: EvalTask,
  trialDir: string,
  fixturesRoot: string,
): Promise<void> {
  if (task.referenceSolution === undefined) {
    return;
  }
  const refSrc = join(fixturesRoot, task.referenceSolution);
  await cp(refSrc, trialDir, { recursive: true });
}
