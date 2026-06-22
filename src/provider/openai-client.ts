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

interface RequestBody {
  model: string;
  messages: CompletionRequest["messages"];
  stream: boolean;
  stream_options?: { include_usage: boolean };
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
    // Use streaming internally so Ollama stops generating when we abort.
    // Non-streaming (`stream:false`) buffers the whole response server-side;
    // closing the HTTP connection does NOT stop Ollama's generation, causing
    // request pile-up when the client times out and retries. With streaming,
    // Ollama stops on connection close — clean cancellation.
    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        if (delay !== undefined) {
          await sleep(delay);
        }
      }

      const controller = new AbortController();
      const body = buildRequestBody(req, true); // stream:true
      body.stream_options = { include_usage: true }; // request token counts in final chunk

      // Create ONE timeout that covers fetch() + SSE read loop.
      // The timer is started BEFORE fetch() so a hanging response-headers phase
      // is bounded by the same deadline as the stream read phase.
      let rejectTimeout!: (err: ProviderError) => void;
      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
      });
      const timer = setTimeout(() => {
        controller.abort();
        rejectTimeout(new ProviderError("Request timed out", { retryable: false }));
      }, this.timeoutMs);

      // Inner async operation: fetch + full SSE read. Raced against timeoutPromise.
      const innerOp = async (): Promise<CompletionResponse> => {
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
          const isAbort = err instanceof Error && err.name === "AbortError";
          throw new ProviderError(isAbort ? "Request timed out" : `Network error: ${String(err)}`, {
            retryable: !isAbort,
          });
        }

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          throw new ProviderError(`HTTP ${response.status}: ${response.statusText}`, {
            statusCode: response.status,
            retryable,
          });
        }

        if (!response.body) {
          throw new ProviderError("Response body is null", { retryable: false });
        }

        // Collect SSE stream into a single CompletionResponse.
        // Race each read() against timeoutPromise. Bun's AbortController does not
        // interrupt a pending reader.read() — the abort signal on the fetch is
        // sufficient to cancel the HTTP connection, but read() keeps blocking.
        // Explicitly racing with a timeout Promise ensures timely cancellation.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let finishReason: string | undefined;
        let usage: CompletionResponse["usage"] | undefined;
        let model = req.model;

        try {
          outer: while (true) {
            const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
              if (data === "[DONE]") break outer;

              let parsed: unknown;
              try {
                parsed = JSON.parse(data);
              } catch {
                continue;
              }

              const chunk = parsed as OpenAIStreamChunk;
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) content += delta;
              const fr = chunk.choices?.[0]?.finish_reason;
              if (fr) finishReason = fr;
              const u = (chunk as { usage?: OpenAIUsage }).usage;
              if (u) {
                usage = {
                  promptTokens: u.prompt_tokens ?? 0,
                  completionTokens: u.completion_tokens ?? 0,
                  totalTokens: u.total_tokens ?? 0,
                };
              }
              const m = (chunk as { model?: string }).model;
              if (m) model = m;
            }
          }
        } catch (err) {
          reader.cancel().catch(() => {});
          reader.releaseLock();
          if (err instanceof ProviderError) throw err;
          const isAbort = err instanceof Error && err.name === "AbortError";
          throw new ProviderError(
            isAbort ? "Request timed out" : `Stream read error: ${String(err)}`,
            { retryable: !isAbort },
          );
        }

        reader.releaseLock();

        return {
          rawContent: content,
          usage,
          model,
          finishReason,
          truncated: finishReason === "length",
        };
      };

      let result: CompletionResponse;
      try {
        result = await Promise.race([innerOp(), timeoutPromise]);
      } catch (err) {
        clearTimeout(timer);
        // Propagate retryable HTTP errors through the retry loop; throw the rest.
        if (err instanceof ProviderError && err.retryable && attempt < MAX_ATTEMPTS - 1) {
          lastError = err;
          continue;
        }
        throw err instanceof ProviderError
          ? err
          : new ProviderError(`Unexpected error: ${String(err)}`, { retryable: false });
      }

      clearTimeout(timer);
      return result;
    }

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
