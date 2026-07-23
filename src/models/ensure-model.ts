import { listOllamaModels, modelIsPulled, type PullResult, pullOllamaModel } from "./ollama.ts";

/**
 * E2-T3 — ensure the active model is actually pulled before a run, offering to
 * `ollama pull` it when it's missing. The whole point is that a first-time user
 * doesn't fail cryptically at the first inference because the model was never
 * downloaded.
 *
 * Policy (the card's contract):
 *   - already present      → proceed, no prompt.
 *   - missing + --yes / auto → pull it, then proceed.
 *   - missing + interactive  → ask "Pull it now? [y/N]"; pull on yes, else block.
 *   - missing + non-interactive without --yes → NEVER pull silently; block with
 *     the `ollama pull <id>` instruction (a headless run must be reproducible).
 *
 * list/pull/confirm are injectable so every branch is unit-tested without a live
 * server or a multi-GB download.
 */

export type EnsureAction = "present" | "pulled" | "declined" | "pull-failed" | "blocked-noninteractive";

export interface EnsureModelResult {
  /** True iff the model is available to run (already present or freshly pulled). */
  ok: boolean;
  action: EnsureAction;
  /** Actionable message on any non-ok path (empty when ok). */
  message: string;
}

export interface EnsureModelOptions {
  /** `--yes`: auto-pull without asking (also the sanctioned non-interactive auto). */
  yes: boolean;
  /** Is this an interactive TTY (so we may prompt)? */
  interactive: boolean;
  /** Injectable prompt; default reads a y/N from stdin. */
  confirm?: (question: string) => Promise<boolean>;
  /** Injectable model list; default hits Ollama's /api/tags. */
  listModels?: (baseUrl: string) => Promise<string[]>;
  /** Injectable pull; default runs `ollama pull <id>`. */
  pull?: (id: string) => Promise<PullResult>;
  /** Injectable logger for the "pulling…" notice; default stderr. */
  log?: (line: string) => void;
}

export async function ensureModelAvailable(
  baseUrl: string,
  modelId: string,
  opts: EnsureModelOptions,
): Promise<EnsureModelResult> {
  const listModels = opts.listModels ?? listOllamaModels;
  const pull = opts.pull ?? pullOllamaModel;
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));

  const installed = await listModels(baseUrl);
  if (modelIsPulled(installed, modelId)) return { ok: true, action: "present", message: "" };

  // Missing. Decide whether we're allowed to pull.
  const pullHint = `Pull it: ollama pull ${modelId}`;
  let shouldPull = opts.yes;
  if (!shouldPull) {
    if (!opts.interactive) {
      // Headless without --yes: never download silently.
      return {
        ok: false,
        action: "blocked-noninteractive",
        message: `Model "${modelId}" is not installed. ${pullHint}  (or re-run with --yes to auto-pull).`,
      };
    }
    const confirm = opts.confirm ?? defaultConfirm;
    shouldPull = await confirm(`Model "${modelId}" is not installed locally. Pull it now (this may download several GB)? [y/N] `);
    if (!shouldPull) {
      return { ok: false, action: "declined", message: `Declined. ${pullHint} when you're ready.` };
    }
  }

  log(`[smallcode] Pulling ${modelId} …`);
  const res = await pull(modelId);
  if (res.ok) return { ok: true, action: "pulled", message: "" };
  return {
    ok: false,
    action: "pull-failed",
    message: `Failed to pull "${modelId}"${res.error ? `: ${res.error}` : ""}. ${pullHint} manually.`,
  };
}

/** Default y/N prompt on stdin. Returns false on anything but an explicit yes. */
async function defaultConfirm(question: string): Promise<boolean> {
  process.stderr.write(question);
  const answer = (prompt("") ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
