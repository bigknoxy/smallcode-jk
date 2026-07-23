/**
 * Native Ollama API helpers for onboarding/distribution (doctor, health check,
 * auto-pull, model validation). The rest of the app talks to Ollama through its
 * OpenAI-compatible endpoint (`{baseUrl}/v1/chat/completions`); these helpers use
 * Ollama's NATIVE API, which lives at the server ROOT (`/api/tags`, `/api/pull`)
 * — so we derive the native base from the OpenAI-compat baseUrl by stripping the
 * trailing `/v1`.
 *
 * fetch/spawn are injectable so every path is unit-testable without a live
 * Ollama server or a real multi-GB pull.
 */

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Strip a trailing `/v1` (and any trailing slashes) to reach Ollama's native API root. */
export function ollamaNativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export interface OllamaProbe {
  ok: boolean;
  /** Populated on failure: a short human reason (timeout, connection refused, HTTP status). */
  error?: string;
}

/**
 * Is the Ollama server reachable? A short timeout so a down server fails FAST
 * (a human "is ollama serve running?" message) instead of hanging on the first
 * inference call. Never throws.
 */
export async function pingOllama(
  baseUrl: string,
  opts?: { timeoutMs?: number; fetchFn?: FetchFn },
): Promise<OllamaProbe> {
  const fetchFn = opts?.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${ollamaNativeBase(baseUrl)}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError → the timeout fired.
    return { ok: false, error: /abort/i.test(msg) ? `no response within ${timeoutMs}ms` : msg };
  } finally {
    clearTimeout(timer);
  }
}

/** The model names Ollama has locally (`ollama list` / `GET /api/tags`). Empty on any failure. */
export async function listOllamaModels(
  baseUrl: string,
  opts?: { timeoutMs?: number; fetchFn?: FetchFn },
): Promise<string[]> {
  const fetchFn = opts?.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${ollamaNativeBase(baseUrl)}/api/tags`, { signal: controller.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is model `id` present among `installed`? Ollama names carry a tag: a bare id
 * (`qwen2.5-coder`) matches `qwen2.5-coder:latest`; a tagged id must match exactly.
 * Pure; exported for testing.
 */
export function modelIsPulled(installed: string[], id: string): boolean {
  if (installed.includes(id)) return true;
  if (!id.includes(":")) return installed.includes(`${id}:latest`);
  return false;
}

export interface PullResult {
  ok: boolean;
  error?: string;
}

/** Injectable process runner so `pullOllamaModel` is testable without a real pull. */
export type SpawnRunner = (cmd: string[]) => Promise<{ exitCode: number }>;

/**
 * Pull a model via the `ollama` CLI (`ollama pull <id>`), streaming its progress
 * to the user's terminal. Returns ok/err rather than throwing so callers can
 * report a clean message. The runner is injectable for tests.
 */
export async function pullOllamaModel(
  id: string,
  opts?: { runner?: SpawnRunner },
): Promise<PullResult> {
  const runner =
    opts?.runner ??
    (async (cmd: string[]) => {
      // Inherit stdio so the user sees Ollama's live download progress.
      const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
      const exitCode = await proc.exited;
      return { exitCode };
    });
  try {
    const { exitCode } = await runner(["ollama", "pull", id]);
    if (exitCode === 0) return { ok: true };
    return { ok: false, error: `\`ollama pull ${id}\` exited ${exitCode}` };
  } catch (err) {
    // e.g. `ollama` not on PATH.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
