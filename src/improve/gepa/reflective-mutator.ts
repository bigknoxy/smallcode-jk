/**
 * Live reflective mutator (GEPA, 2c).
 *
 * `LLMReflectiveMutator` is the production counterpart to `MockMutator`: it
 * asks a STRONG reflection model to diagnose the dominant, generalizable
 * failure pattern across a batch of failed-task transcripts and rewrite the
 * candidate's `system` prompt to fix it — while preserving the FILE:/PATCH:
 * edit-format structure and the TOOL: run_tests/finish protocol.
 *
 * Design:
 *   - The model call is INJECTED as `deps.complete(prompt): Promise<string>`, so
 *     unit tests need no network and no GPU.
 *   - `buildReflectionPrompt` is an exported pure function so the prompt shape
 *     can be asserted directly.
 *   - `makeProviderComplete` adapts the EXISTING provider abstraction
 *     (`createProvider` + `ModelRegistry`) into that single-string `complete`
 *     fn for a real run, configured entirely via env.
 *
 * Robustness contract: ANY failure mode (LLM throws, missing/empty block,
 * suspiciously short result) returns the parent PromptSet UNCHANGED — a no-op
 * mutation — rather than corrupting the candidate, and logs a warning to stderr.
 */

import type { PromptSet } from "../../agent/prompt-set.ts";
import { createProvider } from "../../provider/factory.ts";
import type { Provider } from "../../provider/types.ts";
import { ModelRegistry, defaultRegistry } from "../../models/registry.ts";
import type { ModelProfile } from "../../models/types.ts";
import type { ProviderConfig } from "../../config/types.ts";
import type { FailedInstance } from "./types.ts";
import type { ReflectiveMutator } from "./mutator.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max chars of a single transcript's final rawResponse shown to the reflector. */
export const RAW_RESPONSE_CAP = 1500;
/** Max number of failed instances shown to the reflector (bounds prompt size). */
export const MAX_FAILURES_SHOWN = 4;
/** A parsed system prompt shorter than this is treated as garbage -> no-op. */
export const MIN_SYSTEM_PROMPT_CHARS = 200;

/** Delimiters the reflector must wrap its rewritten system prompt in. */
export const NEW_SYSTEM_OPEN = "<NEW_SYSTEM>";
export const NEW_SYSTEM_CLOSE = "</NEW_SYSTEM>";

export interface BuildReflectionPromptOpts {
  /** When true, ask the reflector to also rewrite the planner. Default false. */
  mutatePlanner?: boolean;
  rawResponseCap?: number;
  maxFailuresShown?: number;
}

// ---------------------------------------------------------------------------
// Prompt builder (pure, exported for unit tests)
// ---------------------------------------------------------------------------

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…[truncated ${s.length - cap} chars]`;
}

/** Compact, model-readable digest of a single failed instance. */
function digestFailure(f: FailedInstance, cap: number): string {
  const turns = f.transcript.turns ?? [];
  const finalTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
  const rawResponse = finalTurn?.rawResponse ?? "(no turns / empty transcript)";
  // Did ANY turn emit a tool call?
  const emittedToolCall = turns.some((t) => (t.toolCalls?.length ?? 0) > 0);

  return [
    `--- FAILED TASK: ${f.taskId} ---`,
    `outcome: ${f.transcript.outcome}`,
    `tool calls emitted in run: ${emittedToolCall ? "yes" : "NO"}`,
    `final turn rawResponse:`,
    truncate(rawResponse, cap),
  ].join("\n");
}

/**
 * Build the reflection prompt fed to the strong reflector model.
 *
 * Pure: no I/O. Includes the parent `system` prompt verbatim plus a compact
 * digest of each (capped) failed instance, and instructs the model to output
 * ONLY the rewritten system prompt inside <NEW_SYSTEM>…</NEW_SYSTEM>.
 */
export function buildReflectionPrompt(
  parent: PromptSet,
  failures: FailedInstance[],
  opts: BuildReflectionPromptOpts = {},
): string {
  const cap = opts.rawResponseCap ?? RAW_RESPONSE_CAP;
  const maxShown = opts.maxFailuresShown ?? MAX_FAILURES_SHOWN;
  const shown = failures.slice(0, maxShown);

  const digests =
    shown.length > 0
      ? shown.map((f) => digestFailure(f, cap)).join("\n\n")
      : "(no failed transcripts were captured for this generation)";

  const plannerSection = opts.mutatePlanner
    ? [
        ``,
        `After the system block, ALSO output a rewritten PLANNER prompt inside`,
        `<NEW_PLANNER> and </NEW_PLANNER>. Keep it short and task-agnostic.`,
        ``,
        `## CURRENT PLANNER PROMPT`,
        parent.planner,
      ].join("\n")
    : "";

  return `You are an expert prompt engineer optimizing the SYSTEM prompt of a small
local coding model. The model edits files to fix seeded bugs in real repos and
is graded by a deterministic test oracle. Below is the CURRENT system prompt,
followed by traces from tasks the model FAILED.

Your job:
1. Read the failed traces and diagnose the SINGLE dominant, GENERALIZABLE
   failure pattern across them (e.g. emits prose instead of an edit block,
   wrong edit format, never calls run_tests/finish, rewrites unrelated code,
   thinks forever without answering). Prefer the pattern that explains the MOST
   failures, not a quirk of one trace.
2. Rewrite the system prompt to fix that pattern.

HARD CONSTRAINTS — the rewrite MUST:
- PRESERVE the FILE: and PATCH: edit-format structure and instructions.
- PRESERVE the TOOL: run_tests / TOOL: finish protocol and the tool syntax.
- Stay GENERAL: do NOT make the prompt task-specific. Do NOT mention any single
  task's identifiers, file names, function names, or variables from the traces.
- Remain a complete, standalone system prompt the model can run with.

Output ONLY the rewritten system prompt, wrapped EXACTLY like this:
${NEW_SYSTEM_OPEN}
<the full rewritten system prompt>
${NEW_SYSTEM_CLOSE}
${plannerSection}

## CURRENT SYSTEM PROMPT
${parent.system}

## FAILED TASK TRACES (${shown.length} shown of ${failures.length})
${digests}
`;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/** Extract the text between an open/close delimiter pair, or null if absent. */
export function extractDelimitedBlock(
  text: string,
  open: string,
  close: string,
): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  const afterOpen = start + open.length;
  const end = text.indexOf(close, afterOpen);
  if (end === -1) return null;
  return text.slice(afterOpen, end).trim();
}

// ---------------------------------------------------------------------------
// LLMReflectiveMutator
// ---------------------------------------------------------------------------

export interface ReflectiveMutatorDeps {
  /** Single-string completion fn (injectable so tests need no network). */
  complete: (prompt: string) => Promise<string>;
  /** Also rewrite the planner prompt. Default false (conservative). */
  mutatePlanner?: boolean;
  /** Override caps (mainly for tests). */
  rawResponseCap?: number;
  maxFailuresShown?: number;
  minSystemPromptChars?: number;
}

function warn(msg: string): void {
  process.stderr.write(`[gepa:reflective-mutator] WARN ${msg}\n`);
}

export class LLMReflectiveMutator implements ReflectiveMutator {
  constructor(private readonly deps: ReflectiveMutatorDeps) {}

  async mutate(parent: PromptSet, failures: FailedInstance[]): Promise<PromptSet> {
    const minChars = this.deps.minSystemPromptChars ?? MIN_SYSTEM_PROMPT_CHARS;

    const prompt = buildReflectionPrompt(parent, failures, {
      mutatePlanner: this.deps.mutatePlanner,
      rawResponseCap: this.deps.rawResponseCap,
      maxFailuresShown: this.deps.maxFailuresShown,
    });

    let raw: string;
    try {
      raw = await this.deps.complete(prompt);
    } catch (err) {
      warn(
        `complete() threw (${err instanceof Error ? err.message : String(err)}); ` +
          `returning parent unchanged (no-op mutation).`,
      );
      return parent;
    }

    const newSystem = extractDelimitedBlock(raw, NEW_SYSTEM_OPEN, NEW_SYSTEM_CLOSE);
    if (newSystem === null) {
      warn(`no ${NEW_SYSTEM_OPEN} block in reflector output; returning parent unchanged.`);
      return parent;
    }
    if (newSystem.length < minChars) {
      warn(
        `parsed system prompt too short (${newSystem.length} < ${minChars} chars); ` +
          `returning parent unchanged.`,
      );
      return parent;
    }

    const mutated: PromptSet = { ...parent, system: newSystem };

    // Planner mutation is conservative: only applied when explicitly requested
    // AND a well-formed, non-empty block is present. Otherwise keep the parent's.
    if (this.deps.mutatePlanner) {
      const newPlanner = extractDelimitedBlock(raw, "<NEW_PLANNER>", "</NEW_PLANNER>");
      if (newPlanner !== null && newPlanner.length > 0) {
        mutated.planner = newPlanner;
      } else {
        warn(`mutatePlanner set but no usable <NEW_PLANNER> block; keeping parent planner.`);
      }
    }

    return mutated;
  }
}

// ---------------------------------------------------------------------------
// Production wiring: build `complete` from the existing provider infra.
// ---------------------------------------------------------------------------

export interface ProviderCompleteConfig {
  /** Provider config (baseUrl/apiKey/timeoutMs). */
  provider: ProviderConfig;
  /** Reflection model id — should resolve in the registry (a STRONG model). */
  modelId: string;
  /** Registry to resolve the model profile (defaults to the global one). */
  registry?: ModelRegistry;
  /** Sampling override; falls back to the profile's defaults. */
  maxTokens?: number;
  temperature?: number;
}

/**
 * Resolve a `ProviderCompleteConfig` from env, matching existing conventions.
 *
 * Env contract:
 *   - SMALLCODE_GEPA_REFLECT_MODEL  (REQUIRED) — reflection model id. Should be
 *     a STRONG model registered in the registry (built-in or via config
 *     `models`). May be an OpenAI-compatible endpoint model or a strong local
 *     model served by the same provider base URL.
 *   - SMALLCODE_GEPA_REFLECT_BASE_URL (optional) — overrides the reflection
 *     provider base URL; falls back to SMALLCODE_BASE_URL then `fallback.baseUrl`.
 *   - SMALLCODE_GEPA_REFLECT_API_KEY  (optional) — overrides the API key;
 *     falls back to SMALLCODE_API_KEY then `fallback.apiKey`.
 *   - SMALLCODE_GEPA_REFLECT_MAX_TOKENS (optional) — sampling cap override.
 *
 * `fallback` is typically the provider config loaded from smallcode.config.json,
 * so a real run reuses the SAME base-url/api-key the rest of the harness reads
 * unless explicitly overridden.
 */
export function reflectConfigFromEnv(
  fallback: ProviderConfig,
  registry: ModelRegistry = defaultRegistry,
): ProviderCompleteConfig {
  const modelId = process.env["SMALLCODE_GEPA_REFLECT_MODEL"];
  if (!modelId) {
    throw new Error(
      "SMALLCODE_GEPA_REFLECT_MODEL is required to build a live reflection completer " +
        "(set it to a STRONG model id registered in the model registry).",
    );
  }

  const baseUrl =
    process.env["SMALLCODE_GEPA_REFLECT_BASE_URL"] ??
    process.env["SMALLCODE_BASE_URL"] ??
    fallback.baseUrl;
  const apiKey =
    process.env["SMALLCODE_GEPA_REFLECT_API_KEY"] ??
    process.env["SMALLCODE_API_KEY"] ??
    fallback.apiKey;

  const maxTokensRaw = process.env["SMALLCODE_GEPA_REFLECT_MAX_TOKENS"];
  const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : undefined;

  return {
    provider: { ...fallback, baseUrl, apiKey },
    modelId,
    registry,
    ...(maxTokens !== undefined && Number.isFinite(maxTokens) ? { maxTokens } : {}),
  };
}

/**
 * Build a single-string `complete` fn backed by the existing provider stack.
 *
 * Reuses `createProvider` + the model registry rather than hand-rolling HTTP.
 * The single-string prompt is adapted into the provider's message shape as a
 * single user turn; the model's reasoning defaults come from its profile.
 */
export function makeProviderComplete(
  cfg: ProviderCompleteConfig,
): (prompt: string) => Promise<string> {
  const registry = cfg.registry ?? defaultRegistry;
  const profile: ModelProfile = registry.get(cfg.modelId);
  const provider: Provider = createProvider(cfg.provider, registry);

  const defaults = profile.samplingDefaults ?? {};
  const temperature = cfg.temperature ?? defaults.temperature;
  const maxTokens = cfg.maxTokens ?? defaults.max_tokens;

  return async (prompt: string): Promise<string> => {
    const res = await provider.complete({
      model: profile.id,
      messages: [{ role: "user", content: prompt }],
      ...(temperature !== undefined ? { temperature } : {}),
      ...(defaults.top_p !== undefined ? { top_p: defaults.top_p } : {}),
      ...(defaults.top_k !== undefined ? { top_k: defaults.top_k } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(profile.ollamaOptions !== undefined ? { ollamaOptions: profile.ollamaOptions } : {}),
    });
    return res.rawContent;
  };
}
