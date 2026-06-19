import { afterEach, describe, expect, test } from "bun:test";
import type { ModelProfile } from "../src/models/types.ts";
import { OpenAICompatibleClient } from "../src/provider/openai-client.ts";
import { buildSamplingParams } from "../src/provider/sampler.ts";
import { ProviderError } from "../src/provider/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseProfile: ModelProfile = {
  id: "test-model",
  label: "Test Model",
  contextWindow: 8192,
  samplingDefaults: {
    temperature: 0.7,
    top_p: 0.95,
    top_k: -1,
    max_tokens: 2048,
  },
  supportsGrammar: false,
  supportsJsonSchema: false,
};

const baseConfig = {
  baseUrl: "http://localhost:11434",
  apiKey: "test-key",
  timeoutMs: 5000,
};

// A simple type alias for mock fetch functions
type MockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

interface ParsedBody {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  top_k?: number;
  stream?: boolean;
  response_format?: unknown;
}

function setMockFetch(fn: MockFetch): void {
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
}

// Capture the original fetch so we can restore it
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// 1. buildSamplingParams — merges defaults correctly
// ---------------------------------------------------------------------------

describe("buildSamplingParams", () => {
  test("returns profile defaults when no overrides", () => {
    const result = buildSamplingParams(baseProfile, {});
    expect(result).toEqual(baseProfile.samplingDefaults);
  });

  // 2. overrides individual fields
  test("overrides individual fields while keeping others", () => {
    const result = buildSamplingParams(baseProfile, { temperature: 0.3 });
    expect(result.temperature).toBe(0.3);
    expect(result.top_p).toBe(0.95);
    expect(result.top_k).toBe(-1);
    expect(result.max_tokens).toBe(2048);
  });

  test("overrides all fields", () => {
    const overrides = { temperature: 1.0, top_p: 0.8, top_k: 40, max_tokens: 512 };
    const result = buildSamplingParams(baseProfile, overrides);
    expect(result).toEqual(overrides);
  });
});

// ---------------------------------------------------------------------------
// 3. complete() — sends correct request body
// ---------------------------------------------------------------------------

describe("OpenAICompatibleClient.complete()", () => {
  test("sends correct request body and maps response", async () => {
    // complete() now uses streaming internally for clean cancellation.
    // Mock returns SSE format.
    const sse = [
      `data: ${JSON.stringify({ model: "test-model", choices: [{ delta: { content: "Hello," }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ model: "test-model", choices: [{ delta: { content: " world!" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ model: "test-model", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    let capturedInit: RequestInit | undefined;

    setMockFetch(async (_input, init) => {
      capturedInit = init;
      return new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const client = new OpenAICompatibleClient(baseConfig);
    const response = await client.complete({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.5,
    });

    expect(response.rawContent).toBe("Hello, world!");
    expect(response.model).toBe("test-model");
    expect(response.finishReason).toBe("stop");
    expect(response.usage?.promptTokens).toBe(10);
    expect(response.usage?.completionTokens).toBe(5);
    expect(response.usage?.totalTokens).toBe(15);

    // complete() uses stream:true internally
    expect(capturedInit).toBeDefined();
    const body = JSON.parse(capturedInit?.body as string) as ParsedBody;
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0.5);
    expect(body.stream).toBe(true);
    expect(body.messages?.[0]?.role).toBe("user");
  });

  // 4. retries on 429 and succeeds on second attempt
  test("retries on 429 and succeeds on second attempt", async () => {
    let callCount = 0;
    const sse = [
      `data: ${JSON.stringify({ model: "test-model", choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    setMockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
      }
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const client = new OpenAICompatibleClient({ ...baseConfig, timeoutMs: 10_000 });
    const response = await client.complete({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(callCount).toBe(2);
    expect(response.rawContent).toBe("OK");
  });

  // 5. throws ProviderError after max retries on 500
  test("throws ProviderError after max retries on 500", async () => {
    let callCount = 0;

    setMockFetch(async () => {
      callCount++;
      return new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      });
    });

    const client = new OpenAICompatibleClient({ ...baseConfig, timeoutMs: 10_000 });

    let thrown: unknown;
    try {
      await client.complete({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      });
    } catch (err) {
      thrown = err;
    }

    expect(callCount).toBe(3);
    expect(thrown).toBeInstanceOf(ProviderError);
    const providerErr = thrown as ProviderError;
    expect(providerErr.statusCode).toBe(500);
    expect(providerErr.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. SSE stream parsing — yields correct deltas in order
// ---------------------------------------------------------------------------

describe("OpenAICompatibleClient.stream()", () => {
  test("parses SSE stream and yields correct deltas in order", async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":", "}}]}',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      "data: [DONE]",
    ];

    const sseText = sseLines.map((l) => `${l}\n`).join("\n");
    const encoder = new TextEncoder();
    const encoded = encoder.encode(sseText);

    setMockFetch(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const client = new OpenAICompatibleClient(baseConfig);
    const chunks: string[] = [];
    let doneCount = 0;

    for await (const chunk of client.stream({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      if (chunk.done) {
        doneCount++;
      } else {
        chunks.push(chunk.delta);
      }
    }

    expect(chunks).toEqual(["Hello", ", ", "world"]);
    expect(doneCount).toBeGreaterThanOrEqual(1);
  });

  test("skips empty SSE lines gracefully", async () => {
    const sseText = [
      "",
      "",
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const encoder = new TextEncoder();
    setMockFetch(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseText));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const client = new OpenAICompatibleClient(baseConfig);
    const chunks: string[] = [];
    for await (const chunk of client.stream({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    })) {
      if (!chunk.done) chunks.push(chunk.delta);
    }
    expect(chunks).toEqual(["Hi"]);
  });
});

// ---------------------------------------------------------------------------
// 7. top_k=-1 is NOT sent; top_k=40 IS sent
// ---------------------------------------------------------------------------

describe("top_k request body handling", () => {
  async function captureBody(topK?: number): Promise<ParsedBody> {
    let captured: ParsedBody = {};
    setMockFetch(async (_input, init) => {
      captured = JSON.parse(init?.body as string) as ParsedBody;
      return new Response(
        JSON.stringify({
          model: "test-model",
          choices: [{ message: { content: "" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = new OpenAICompatibleClient(baseConfig);
    await client.complete({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      top_k: topK,
    });
    return captured;
  }

  test("top_k=-1 is NOT included in request body", async () => {
    const body = await captureBody(-1);
    expect(Object.keys(body)).not.toContain("top_k");
  });

  test("top_k=40 IS included in request body", async () => {
    const body = await captureBody(40);
    expect(body.top_k).toBe(40);
  });

  test("top_k=undefined is NOT included in request body", async () => {
    const body = await captureBody(undefined);
    expect(Object.keys(body)).not.toContain("top_k");
  });
});
