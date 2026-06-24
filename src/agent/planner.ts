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
Each sub-goal must be a concrete ACTION starting with an action verb (e.g. Add, Fix, Implement, Write, Update, Remove, Refactor, Run).
Do NOT output file paths or line ranges as goals — those are context, not actions.
Output ONLY a numbered list of sub-goals. No prose, no explanation.
Prefer 1–3 sub-goals for a small task; maximum 5.
Example:
1. Add the missing null check in parseConfig
2. Write a unit test for the new branch
3. Run tests to verify the fix`;

const REFLECTION_SYSTEM_PROMPT = `You are a coding assistant. Briefly reflect on a task before planning.
In 2-3 sentences: restate the core problem, note the key constraint or edge case to watch for.
Output ONLY the reflection — no list, no headings, no code.`;

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `desc` describes a real actionable goal (starts with an
 * action verb, has meaningful prose). Returns false for bare file paths,
 * "path (lines X–Y)" echoes, single-word nouns, or short strings with no
 * action content.
 *
 * Rule of thumb: reject if the trimmed text looks like a filesystem path or
 * path-with-line-range with no action words; accept anything else.
 */
export function isActionableGoal(desc: string): boolean {
  const t = desc.trim();
  if (!t) return false;

  // Reject single-word entries (e.g. "TODO", a bare filename, a directory name)
  if (!/\s/.test(t)) return false;

  // Reject entries that are purely a path (optional trailing slash) with no
  // action prose. A "path" here means something that:
  //   - starts with an optional "./" or "../"
  //   - contains path segments (word chars + slashes + dots) but no spaces
  //     EXCEPT for a trailing " (lines X–Y)" or " (lines X-Y)" annotation.
  // Pattern: <path-like-token> optionally followed by " (lines N–N)" or " (lines N-N)"
  // and nothing else meaningful after that.
  const pathEchoPattern =
    /^(?:\.{0,2}\/)?[\w./\\-]+(?: \(lines \d+[–-]\d+\))?$/i;
  if (pathEchoPattern.test(t)) return false;

  // A goal that mentions a path is fine as long as it also contains a verb /
  // action word. We verify this by checking that the string has at least two
  // space-separated tokens beyond the (optional) path portion, OR that the
  // first "real word" is an obvious action verb or the sentence has ≥4 words.
  // Simplest reliable check: the description must have ≥2 whitespace-separated
  // words AND must not SOLELY be a path-with-annotation.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;

  return true;
}

/**
 * Returns the max number of goals to generate for a task.
 * Small/single-file tasks → 3; otherwise → 5.
 */
export function maxGoalsForTask(task: string, uniqueFileCount: number): number {
  if (uniqueFileCount <= 1) return 3;

  // Heuristic: a "short" task is one with ≤10 words and references at most 1
  // file path token (contains a "/" or ".ts"/".js" etc.).
  const words = task.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 10) {
    // Count how many words look like file paths
    const pathLike = words.filter((w) => /[/.]/.test(w));
    if (pathLike.length <= 1) return 3;
  }

  return 5;
}

function parseGoals(text: string, task: string, uniqueFileCount: number): Goal[] {
  const lines = text.split("\n");
  const raw: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match numbered list: "1. Do X" or "1) Do X"
    const numberedMatch = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (numberedMatch !== null) {
      const description = numberedMatch[1]?.trim();
      if (description) raw.push(description);
      continue;
    }

    // Match bullet list: "- Do X" or "* Do X"
    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bulletMatch !== null) {
      const description = bulletMatch[1]?.trim();
      if (description) raw.push(description);
    }
  }

  // Filter non-actionable goals and drop exact duplicates
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const desc of raw) {
    if (!isActionableGoal(desc)) continue;
    if (seen.has(desc)) continue;
    seen.add(desc);
    filtered.push(desc);
  }

  const cap = maxGoalsForTask(task, uniqueFileCount);
  return filtered.slice(0, cap).map((description, i) => ({
    id: `goal-${i + 1}`,
    description,
    status: "pending",
  }));
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
  // Sanitize context summary: unique file paths only, no line ranges, capped at 8
  const uniquePaths = [...new Set(context.chunks.map((c) => c.filePath))].slice(0, 8);
  const contextSummary =
    uniquePaths.length > 0
      ? uniquePaths.join(", ")
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

Files to consult: ${contextSummary}${reflectionNote}

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

    const goals = parseGoals(response.rawContent, task, uniquePaths.length);
    if (goals.length === 0) {
      return buildFallback(task);
    }
    return goals;
  } catch {
    return buildFallback(task);
  }
}
