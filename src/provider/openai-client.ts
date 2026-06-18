import type { ProviderConfig } from "../config/types.ts";
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "./types.ts";
import { ProviderError } from "./types.ts";

const RETRY_DELAYS_MS = [200, 400, 800] as const;
const MAX_ATTEMPTS = 3;

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIDelta {
  content?: string;
}

interface OpenAIStreamChoice {
  delta?: OpenAIDelta;
  finish_reason?: string | null;
}

interface OpenAIStreamChunk {
  choices?: OpenAIStreamChoice[];
}

interface OpenAIChoice {
  message?: { content?: string };
  finish_reason?: string | null;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
  model?: string;
}

interface RequestBody {
  model: string;
  messages: CompletionRequest["messages"];
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  top_k?: number;
  response_format?:
    | { type: "json_schema"; json_schema: Record<string, unknown> }
    | { type: "text" };
  /** Ollama-specific model parameters (e.g. num_ctx). Ignored by non-Ollama backends. */
  options?: Record<string, number>;
}

function buildRequestBody(req: CompletionRequest, stream: boolean): RequestBody {
  const body: RequestBody = {
    model: req.model,
    messages: req.messages,
    stream,
  };

  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;

  // top_k is non-standard — only include if not -1
  if (req.top_k !== undefined && req.top_k !== -1) {
    body.top_k = req.top_k;
  }

  if (req.responseFormat !== undefined) {
    if (req.responseFormat.type === "json_schema") {
      body.response_format = { type: "json_schema", json_schema: req.responseFormat.schema };
    } else {
      body.response_format = { type: "text" };
    }
  }

  if (req.ollamaOptions !== undefined && Object.keys(req.ollamaOptions).length > 0) {
    body.options = req.ollamaOptions;
  }

  return body;
}

export class OpenAICompatibleClient implements Provider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = buildRequestBody(req, false);

    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        if (delay !== undefined) {
          await sleep(delay);
        }
      }

      // Use Promise.race for the full request+body cycle.
      // AbortController.abort() does not interrupt response.json() once headers
      // arrive — Ollama returns 200 immediately then streams the body, so the
      // old abort-based approach would clear on header arrival and then hang
      // indefinitely waiting for the JSON body.
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new ProviderError("Request timed out", { retryable: false })),
          this.timeoutMs,
        ),
      );

      const controller = new AbortController();

      const requestPromise = fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            const err = new ProviderError(`HTTP ${response.status}: ${response.statusText}`, {
              statusCode: response.status,
              retryable: isRetryableStatus(response.status),
            });
            throw err;
          }
          const raw: unknown = await response.json();
          return parseCompletionResponse(raw, req.model);
        })
        .catch((err: unknown) => {
          if (err instanceof ProviderError) throw err;
          const isAbort = err instanceof Error && err.name === "AbortError";
          throw new ProviderError(isAbort ? "Request timed out" : `Network error: ${String(err)}`, {
            retryable: !isAbort,
          });
        });

      try {
        return await Promise.race([requestPromise, timeoutPromise]);
      } catch (err) {
        controller.abort(); // cancel underlying fetch if timeout won
        if (err instanceof ProviderError) {
          lastError = err;
          if (err.retryable && attempt < MAX_ATTEMPTS - 1) continue;
          throw err;
        }
        throw new ProviderError(String(err), { retryable: false });
      }
    }

    // Should not reach here, but satisfy TS
    throw lastError ?? new ProviderError("Max retries exceeded", { retryable: false });
  }

  async *stream(req: CompletionRequest): AsyncGenerator<StreamChunk> {
    const body = buildRequestBody(req, true);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      throw new ProviderError(isAbort ? "Request timed out" : `Network error: ${String(err)}`, {
        retryable: !isAbort,
      });
    }

    if (!response.ok) {
      clearTimeout(timer);
      throw new ProviderError(`HTTP ${response.status}: ${response.statusText}`, {
        statusCode: response.status,
        retryable: isRetryableStatus(response.status),
      });
    }

    if (!response.body) {
      clearTimeout(timer);
      throw new ProviderError("Response body is null", { retryable: false });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          if (!trimmed.startsWith("data:")) continue;

          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            yield { delta: "", done: true };
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            // Malformed SSE line — skip
            continue;
          }

          const chunk = parsed as OpenAIStreamChunk;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta !== undefined && delta !== null) {
            yield { delta, done: false };
          }
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }

    yield { delta: "", done: true };
  }
}

function parseCompletionResponse(raw: unknown, fallbackModel: string): CompletionResponse {
  const data = raw as OpenAIResponse;

  const choice = data.choices?.[0];
  const rawContent = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason ?? undefined;

  // Truncation: explicitly cut short by token budget.
  const truncated = finishReason === "length";

  let usage: CompletionResponse["usage"];
  if (data.usage) {
    usage = {
      promptTokens: data.usage.prompt_tokens ?? 0,
      completionTokens: data.usage.completion_tokens ?? 0,
      totalTokens: data.usage.total_tokens ?? 0,
    };
  }

  return {
    rawContent,
    usage,
    model: data.model ?? fallbackModel,
    finishReason: finishReason ?? undefined,
    truncated,
  };
}
