import type { ContextBundle } from "@/context/types.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { Provider } from "@/provider/types.ts";
import type { Goal } from "./types.ts";

export interface PlannerOptions {
  provider: Provider;
  modelId: string;
  profile: ModelProfile;
  repoRoot: string;
  preSolveReflection?: boolean; // if true, run a brief reflection step before decomposing (default: false)
  plannerPrompt?: string; // override the planner system prompt (GEPA seam)
  reflectionPrompt?: string; // override the reflection system prompt (GEPA seam)
}

const PLANNER_SYSTEM_PROMPT = `You are a coding assistant that plans tasks as ordered sub-goals.
Each sub-goal must be small, concrete, and independently verifiable.
Output ONLY a numbered list of sub-goals. No prose, no explanation.
Maximum 8 sub-goals. Example:
1. Read src/foo.ts to understand the current structure
2. Add the missing null check in parseConfig
3. Run tests to verify the fix`;

const REFLECTION_SYSTEM_PROMPT = `You are a coding assistant. Briefly reflect on a task before planning.
In 2-3 sentences: restate the core problem, note the key constraint or edge case to watch for.
Output ONLY the reflection — no list, no headings, no code.`;

function parseGoals(text: string): Goal[] {
  const lines = text.split("\n");
  const goals: Goal[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match numbered list: "1. Do X" or "1) Do X"
    const numberedMatch = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (numberedMatch !== null) {
      const description = numberedMatch[1]?.trim();
      if (description) {
        goals.push({
          id: `goal-${goals.length + 1}`,
          description,
          status: "pending",
        });
      }
      continue;
    }

    // Match bullet list: "- Do X" or "* Do X"
    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bulletMatch !== null) {
      const description = bulletMatch[1]?.trim();
      if (description) {
        goals.push({
          id: `goal-${goals.length + 1}`,
          description,
          status: "pending",
        });
      }
    }
  }

  return goals.slice(0, 8);
}

function buildFallback(task: string): Goal[] {
  return [{ id: "goal-1", description: task, status: "pending" }];
}

async function runReflection(
  task: string,
  contextSummary: string,
  opts: PlannerOptions,
): Promise<string> {
  const systemPrompt = opts.reflectionPrompt ?? REFLECTION_SYSTEM_PROMPT;
  const userMessage = `Task: ${task}\n\nRelevant files: ${contextSummary}\n\nReflect briefly on this task.`;
  try {
    const response = await opts.provider.complete({
      model: opts.modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: opts.profile.samplingDefaults.temperature,
      max_tokens: 128,
    });
    return response.rawContent.trim();
  } catch {
    return "";
  }
}

export async function planTask(
  task: string,
  context: ContextBundle,
  opts: PlannerOptions,
): Promise<Goal[]> {
  const contextSummary =
    context.chunks.length > 0
      ? context.chunks.map((c) => `${c.filePath} (lines ${c.startLine}–${c.endLine})`).join(", ")
      : "No context provided.";

  // Optional pre-solve reflection step
  let reflectionNote = "";
  if (opts.preSolveReflection === true) {
    const reflection = await runReflection(task, contextSummary, opts);
    if (reflection) {
      reflectionNote = `\n\nKey observations: ${reflection}`;
    }
  }

  const userMessage = `Task: ${task}

Relevant files: ${contextSummary}${reflectionNote}

Plan this task as an ordered list of sub-goals.`;

  const plannerSystemPrompt = opts.plannerPrompt ?? PLANNER_SYSTEM_PROMPT;
  try {
    const response = await opts.provider.complete({
      model: opts.modelId,
      messages: [
        { role: "system", content: plannerSystemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: opts.profile.samplingDefaults.temperature,
      max_tokens: 512,
    });

    const goals = parseGoals(response.rawContent);
    if (goals.length === 0) {
      return buildFallback(task);
    }
    return goals;
  } catch {
    return buildFallback(task);
  }
}
