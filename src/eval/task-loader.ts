// Task files are JSON only (not YAML) — easy machine-readable format with no extra deps.
// Extension must be .json. Fields may be snake_case (camelCase also accepted).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { EvalSuite, EvalTask, SuiteKind } from "./types.ts";

// ---------------------------------------------------------------------------
// Zod schema — accepts both camelCase and snake_case field names via transform
// ---------------------------------------------------------------------------

const TaskSetupSchema = z
  .object({
    repo_fixture: z.string().optional(),
    repoFixture: z.string().optional(),
    files: z.record(z.string(), z.string()).optional(),
  })
  .transform((v) => ({
    repoFixture: v.repoFixture ?? v.repo_fixture,
    files: v.files,
  }));

const DeterministicGraderSchema = z.object({
  type: z.literal("deterministic_tests"),
  required: z.array(z.string()),
  command: z.string().optional(),
});

const StaticGraderSchema = z.object({
  type: z.literal("static_analysis"),
  commands: z.array(z.string()),
});

const LLMRubricGraderSchema = z.object({
  type: z.literal("llm_rubric"),
  rubric: z.string(),
  dimensions: z.array(z.string()).optional(),
});

const GraderConfigSchema = z.discriminatedUnion("type", [
  DeterministicGraderSchema,
  StaticGraderSchema,
  LLMRubricGraderSchema,
]);

const EvalTaskSchema = z
  .object({
    id: z.string(),
    desc: z.string(),
    setup: TaskSetupSchema,
    graders: z.array(GraderConfigSchema),
    // accept both snake_case and camelCase
    tracked_metrics: z.array(z.string()).optional(),
    trackedMetrics: z.array(z.string()).optional(),
    reference_solution: z.string().optional(),
    referenceSolution: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .transform((v) => {
    const metrics = v.trackedMetrics ?? v.tracked_metrics;
    if (!metrics) {
      throw new Error("EvalTask: 'trackedMetrics' (or 'tracked_metrics') is required");
    }
    return {
      id: v.id,
      desc: v.desc,
      setup: v.setup,
      graders: v.graders,
      trackedMetrics: metrics,
      referenceSolution: v.referenceSolution ?? v.reference_solution,
      tags: v.tags,
    } satisfies EvalTask;
  });

const SuiteManifestSchema = z.object({
  id: z.string(),
  kind: z.enum(["capability", "regression", "mixed"]),
  description: z.string(),
  defaultTrials: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadTask(filePath: string): Promise<EvalTask> {
  const raw = await readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadTask: failed to parse JSON from ${filePath}: ${String(err)}`);
  }
  const result = EvalTaskSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `loadTask: invalid task at ${filePath}: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}

export async function loadSuite(suiteDir: string): Promise<EvalSuite> {
  const entries = await readdir(suiteDir);

  // Load manifest if present
  let suiteId = suiteDir.split("/").pop() ?? "unknown";
  let suiteKind: SuiteKind = "mixed";
  let suiteDescription = "";
  let defaultTrials = 1;

  if (entries.includes("suite.json")) {
    const manifestRaw = await readFile(join(suiteDir, "suite.json"), "utf-8");
    const manifestParsed: unknown = JSON.parse(manifestRaw);
    const manifestResult = SuiteManifestSchema.safeParse(manifestParsed);
    if (!manifestResult.success) {
      throw new Error(
        `loadSuite: invalid suite.json in ${suiteDir}: ${manifestResult.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    suiteId = manifestResult.data.id;
    suiteKind = manifestResult.data.kind;
    suiteDescription = manifestResult.data.description;
    defaultTrials = manifestResult.data.defaultTrials ?? 1;
  }

  // Infer kind from directory name if no manifest
  if (!entries.includes("suite.json")) {
    const dirName = suiteDir.split("/").pop() ?? "";
    if (dirName === "capability") suiteKind = "capability";
    else if (dirName === "regression") suiteKind = "regression";
    else suiteKind = "mixed";
  }

  // Load all task JSON files (excluding suite.json)
  const taskFiles = entries.filter((e) => e.endsWith(".json") && e !== "suite.json");
  const tasks = await Promise.all(taskFiles.map((f) => loadTask(join(suiteDir, f))));

  return {
    id: suiteId,
    kind: suiteKind,
    description: suiteDescription,
    tasks,
    defaultTrials,
  };
}
