/**
 * Unit tests for WatchdogProvider and maybeWrapWatchdog.
 *
 * All tests use:
 *   - A fake inner Provider (returns canned CompletionResponse)
 *   - A fake injected `now` clock (advance by fixed delta per call pair)
 *   - A fake `reload` that records calls
 *
 * No Ollama is started; no live model calls are made; `ollama stop` is never
 * invoked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WatchdogProvider, maybeWrapWatchdog } from "../src/provider/watchdog.ts";
import type { WatchdogOptions } from "../src/provider/watchdog.ts";
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "../src/provider/types.ts";
import { ProviderError } from "../src/provider/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_REQ: CompletionRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
};

/** Build a fake CompletionResponse with controllable completionTokens. */
function fakeResponse(completionTokens: number): CompletionResponse {
  return {
    rawContent: "hello",
    model: "test-model",
    finishReason: "stop",
    usage: {
      promptTokens: 10,
      completionTokens,
      totalTokens: 10 + completionTokens,
    },
  };
}

/**
 * Build a fake inner Provider.
 * Each call to complete() returns responses from the queue in order.
 * If `shouldThrow` is set for a given call index, it throws instead.
 */
function makeFakeProvider(responses: Array<CompletionResponse | "throw">): Provider {
  let idx = 0;
  return {
    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      const r = responses[idx++];
      if (r === "throw" || r === undefined) {
        throw new ProviderError("inner error", { retryable: false });
      }
      return r;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(_req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
      yield { delta: "hi", done: false };
      yield { delta: "", done: true };
    },
  };
}

/**
 * Build a fake clock factory.
 * Each call to `now()` alternates between "start of request" and "end of
 * request" values. `wallMs` controls how long each generation appears to take.
 * Call pattern inside WatchdogProvider: startMs = now(); ... endMs = now();
 */
function makeFakeClock(wallMsPerCall: number): () => number {
  let callIndex = 0;
  let cumulative = 0;
  return () => {
    // Even calls = start-of-request, odd calls = end-of-request
    if (callIndex % 2 === 0) {
      callIndex++;
      return cumulative;
    } else {
      cumulative += wallMsPerCall;
      callIndex++;
      return cumulative;
    }
  };
}

/** A clock that returns a fixed sequence of absolute timestamps. */
function makeSequenceClock(timestamps: number[]): () => number {
  let i = 0;
  return () => timestamps[i++] ?? 0;
}

// ---------------------------------------------------------------------------
// Default options used across tests
// ---------------------------------------------------------------------------

const DEFAULTS: Required<Pick<WatchdogOptions, "thresholdTps" | "consecutiveSlow" | "minTokens">> =
  {
    thresholdTps: 20,
    consecutiveSlow: 2,
    minTokens: 64,
  };

// ---------------------------------------------------------------------------
// Test: fast generations never trigger reload
// ---------------------------------------------------------------------------

describe("WatchdogProvider — fast generations", () => {
  test("fast gens (tps > threshold) never trigger reload", async () => {
    const reloadCalls: string[] = [];
    // 100 tokens in 500 ms = 200 tok/s — well above threshold of 20
    const provider = new WatchdogProvider(
      makeFakeProvider([
        fakeResponse(100),
        fakeResponse(100),
        fakeResponse(100),
      ]),
      {
        ...DEFAULTS,
        now: makeFakeClock(500), // 100 tokens / 0.5s = 200 tok/s
        reload: async (m) => { reloadCalls.push(m); },
      },
    );

    await provider.complete(BASE_REQ);
    await provider.complete(BASE_REQ);
    await provider.complete(BASE_REQ);

    expect(reloadCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: 2 consecutive slow gens trigger exactly one reload
// ---------------------------------------------------------------------------

describe("WatchdogProvider — consecutive slow gens", () => {
  test("2 consecutive slow gens trigger exactly one reload with correct model", async () => {
    const reloadCalls: string[] = [];
    // 64 tokens in 10000 ms = 6.4 tok/s — below threshold of 20
    const provider = new WatchdogProvider(
      makeFakeProvider([
        fakeResponse(64),
        fakeResponse(64),
      ]),
      {
        ...DEFAULTS,
        now: makeFakeClock(10_000), // 64 / 10s = 6.4 tok/s
        reload: async (m) => { reloadCalls.push(m); },
      },
    );

    await provider.complete(BASE_REQ);
    expect(reloadCalls).toHaveLength(0); // first slow — counter = 1

    await provider.complete(BASE_REQ);
    expect(reloadCalls).toHaveLength(1); // second slow — counter hits 2 → reload
    expect(reloadCalls[0]).toBe("test-model");
  });

  test("reload is triggered with the model name from the request", async () => {
    const reloadCalls: string[] = [];
    const req: CompletionRequest = { ...BASE_REQ, model: "my-custom-model" };
    const provider = new WatchdogProvider(
      makeFakeProvider([fakeResponse(64), fakeResponse(64)]),
      {
        ...DEFAULTS,
        now: makeFakeClock(10_000),
        reload: async (m) => { reloadCalls.push(m); },
      },
    );

    await provider.complete(req);
    await provider.complete(req);

    expect(reloadCalls[0]).toBe("my-custom-model");
  });
});

// ---------------------------------------------------------------------------
// Test: fast gen between slow gens resets the counter
// ---------------------------------------------------------------------------

describe("WatchdogProvider — counter reset", () => {
  test("fast gen between slow gens resets counter, no reload triggered", async () => {
    const reloadCalls: string[] = [];
    // slow (6.4 tok/s), fast (200 tok/s), slow (6.4 tok/s) — should NOT reload
    // because the fast gen resets counter after the first slow gen
    const timestamps = [
      0, 10_000,    // gen 1 slow: 64 tok in 10s = 6.4 tok/s
      10_000, 10_500, // gen 2 fast: 100 tok in 0.5s = 200 tok/s
      10_500, 20_500, // gen 3 slow: 64 tok in 10s = 6.4 tok/s
    ];
    const provider = new WatchdogProvider(
      makeFakeProvider([
        fakeResponse(64),
        fakeResponse(100),
        fakeResponse(64),
      ]),
      {
        ...DEFAULTS,
        now: makeSequenceClock(timestamps),
        reload: async (m) => { reloadCalls.push(m); },
      },
    );

    await provider.complete(BASE_REQ); // slow → count=1
    await provider.complete(BASE_REQ); // fast → count=0 (reset)
    await provider.complete(BASE_REQ); // slow → count=1 (not yet 2)

    expect(reloadCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: tiny gens (< minTokens) are ignored
// ---------------------------------------------------------------------------

describe("WatchdogProvider — minTokens filter", () => {
  test("gens with completionTokens < minTokens are ignored even if slow", async () => {
    const reloadCalls: string[] = [];
    // 10 tokens < minTokens=64, so these tiny slow gens should be invisible
    const provider = new WatchdogProvider(
      makeFakeProvider([
        fakeResponse(10),
        fakeResponse(10),
        fakeResponse(10),
        fakeResponse(10),
      ]),
      {
        ...DEFAULTS,
        now: makeFakeClock(10_000), // would be 1 tok/s — far below threshold
        reload: async (m) => { reloadCalls.push(m); },
      },
    );

    await provider.complete(BASE_REQ);
    await provider.complete(BASE_REQ);
    await provider.complete(BASE_REQ);
    await provider.complete(BASE_REQ);

    expect(reloadCalls).toHaveLength(0);
  });

  test("gens exactly at minTokens ARE evaluated", async () => {
    const reloadCalls: string[] = [];
    // Exactly 64 tokens = minTokens, slow → should count
    const provider = new WatchdogProvider(
      makeFakeProvider([fakeResponse(64), fakeResponse(64)]),
      {
        ...DEFAULTS,
        now: makeFakeClock(10_000), // 64/10s = 6.4 tok/s < 20
        reload: async (m) => { reloadCalls.push(m); },
      },
    );

    await provider.complete(BASE_REQ);
    await provider.complete(BASE_REQ);

    expect(reloadCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test: thrown inner errors propagate and are NOT counted
// ---------------------------------------------------------------------------

describe("WatchdogProvider — error handling", () => {
  test("thrown inner error propagates as-is", async () => {
    const provider = new WatchdogProvider(
      makeFakeProvider(["throw"]),
      {
        ...DEFAULTS,
        now: makeFakeClock(10_000),
        reload: async () => {},
      },
    );

    let thrown: unknown;
    try {
      await provider.complete(BASE_REQ);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).message).toBe("inner error");
  });

  test("error does NOT count toward slow counter — still need 2 slow after", async () => {
    const reloadCalls: string[] = [];
    // Sequence: slow, throw, slow — counter must hit 2 consecutive slow gens.
    // The throw resets nothing (it's not counted), so: slow(1), throw(ignored), slow(2) → reload.
    // But per spec: "If inner complete() throws, propagate and do NOT count it".
    // The counter is NOT incremented by a throw, but it is also NOT reset.
    // So after: slow(count=1), throw(count stays 1), slow(count=2) → reload.
    const timestamps = [
      0, 10_000,     // gen 1 slow: 64/10s = 6.4 tok/s  (start=0, end=10_000)
      20_000,        // gen 2 start (throw — end is never read, so only one timestamp consumed)
      30_000, 40_000, // gen 3 slow: 64/10s = 6.4 tok/s (start=30_000, end=40_000)
    ];
    const clockValues = makeSequenceClock(timestamps);

    const inner: Provider = {
      async complete(_req): Promise<CompletionResponse> {
        // We track calls manually to simulate: success, throw, success
        const call = (inner as unknown as { _call: number })._call++;
        if (call === 1) throw new ProviderError("inner error", { retryable: false });
        return fakeResponse(64);
      },
      async *stream(): AsyncIterableIterator<StreamChunk> {
        yield { delta: "", done: true };
      },
    };
    (inner as unknown as { _call: number })._call = 0;

    const provider = new WatchdogProvider(inner, {
      ...DEFAULTS,
      now: clockValues,
      reload: async (m) => { reloadCalls.push(m); },
    });

    await provider.complete(BASE_REQ); // slow → count=1
    try { await provider.complete(BASE_REQ); } catch { /* expected */ } // throw — not counted
    await provider.complete(BASE_REQ); // slow → count=2 → reload

    expect(reloadCalls).toHaveLength(1);
  });

  test("multiple errors in a row do not trigger reload", async () => {
    const reloadCalls: string[] = [];
    const provider = new WatchdogProvider(
      makeFakeProvider(["throw", "throw", "throw", "throw"]),
      {
        ...DEFAULTS,
        now: makeFakeClock(10_000),
        reload: async (m) => { reloadCalls.push(m); },
      },
    );

    for (let i = 0; i < 4; i++) {
      try { await provider.complete(BASE_REQ); } catch { /* expected */ }
    }

    expect(reloadCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: maybeWrapWatchdog — disabled mode
// ---------------------------------------------------------------------------

describe("maybeWrapWatchdog — disabled", () => {
  let savedWatchdog: string | undefined;

  beforeEach(() => {
    savedWatchdog = process.env["SMALLCODE_WATCHDOG"];
  });

  afterEach(() => {
    if (savedWatchdog === undefined) {
      delete process.env["SMALLCODE_WATCHDOG"];
    } else {
      process.env["SMALLCODE_WATCHDOG"] = savedWatchdog;
    }
  });

  test("SMALLCODE_WATCHDOG=0 returns inner provider unchanged", async () => {
    process.env["SMALLCODE_WATCHDOG"] = "0";

    const reloadCalls: string[] = [];
    const inner = makeFakeProvider([fakeResponse(64), fakeResponse(64)]);
    const wrapped = maybeWrapWatchdog(inner, {
      ...DEFAULTS,
      now: makeFakeClock(10_000),
      reload: async (m) => { reloadCalls.push(m); },
    });

    // When disabled, returns inner directly — so it's the same object
    expect(wrapped).toBe(inner);
  });

  test("disabled provider returns inner results and never reloads", async () => {
    process.env["SMALLCODE_WATCHDOG"] = "0";

    const reloadCalls: string[] = [];
    const inner = makeFakeProvider([
      fakeResponse(64),
      fakeResponse(64),
    ]);
    const wrapped = maybeWrapWatchdog(inner, {
      ...DEFAULTS,
      now: makeFakeClock(10_000),
      reload: async (m) => { reloadCalls.push(m); },
    });

    const r1 = await wrapped.complete(BASE_REQ);
    const r2 = await wrapped.complete(BASE_REQ);

    expect(r1.usage?.completionTokens).toBe(64);
    expect(r2.usage?.completionTokens).toBe(64);
    expect(reloadCalls).toHaveLength(0);
  });

  test("SMALLCODE_WATCHDOG unset (default) wraps with WatchdogProvider", () => {
    delete process.env["SMALLCODE_WATCHDOG"];

    const inner = makeFakeProvider([]);
    const wrapped = maybeWrapWatchdog(inner, {
      ...DEFAULTS,
      now: makeFakeClock(500),
      reload: async () => {},
    });

    expect(wrapped).toBeInstanceOf(WatchdogProvider);
  });

  test("SMALLCODE_WATCHDOG=1 wraps with WatchdogProvider", () => {
    process.env["SMALLCODE_WATCHDOG"] = "1";

    const inner = makeFakeProvider([]);
    const wrapped = maybeWrapWatchdog(inner, {
      ...DEFAULTS,
      now: makeFakeClock(500),
      reload: async () => {},
    });

    expect(wrapped).toBeInstanceOf(WatchdogProvider);
  });
});

// ---------------------------------------------------------------------------
// Test: stream() is a pure pass-through
// ---------------------------------------------------------------------------

describe("WatchdogProvider — stream passthrough", () => {
  test("stream() yields inner chunks unchanged", async () => {
    const provider = new WatchdogProvider(
      makeFakeProvider([]),
      {
        ...DEFAULTS,
        now: makeFakeClock(500),
        reload: async () => {},
      },
    );

    const chunks: string[] = [];
    for await (const chunk of provider.stream(BASE_REQ)) {
      if (!chunk.done) chunks.push(chunk.delta);
    }
    expect(chunks).toEqual(["hi"]);
  });
});

// ---------------------------------------------------------------------------
// Test: counter resets after a reload trigger
// ---------------------------------------------------------------------------

describe("WatchdogProvider — counter reset after reload", () => {
  test("counter resets to 0 after a reload, so next slow gen starts fresh", async () => {
    const reloadCalls: string[] = [];
    // slow, slow → reload (count resets to 0), slow → count=1 (no second reload)
    const provider = new WatchdogProvider(
      makeFakeProvider([
        fakeResponse(64),
        fakeResponse(64),
        fakeResponse(64),
      ]),
      {
        ...DEFAULTS,
        now: makeFakeClock(10_000),
        reload: async (m) => { reloadCalls.push(m); },
      },
    );

    await provider.complete(BASE_REQ); // slow → count=1
    await provider.complete(BASE_REQ); // slow → count=2 → reload, reset to 0
    await provider.complete(BASE_REQ); // slow → count=1 (only one slow after reset)

    expect(reloadCalls).toHaveLength(1);
  });
});
