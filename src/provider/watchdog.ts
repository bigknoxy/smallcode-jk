/**
 * WatchdogProvider — throughput-based KV-cache decay detector for Ollama.
 *
 * Background: On macOS Apple Silicon, llama.cpp KV-cache fragmentation causes
 * VibeThinker-3B throughput to decay from ~100 tok/s to ~10 tok/s over several
 * hours of sustained generation. The proven fix is to unload the model
 * (`ollama stop <model>`), which rebuilds the KV buffer. The next request
 * reloads it at full speed.
 *
 * Critical design constraint — Ollama serves ONE request at a time (single
 * slot). An active health-probe would collide with in-flight generations and
 * produce spurious timeouts → false restarts that kill good work. This watchdog
 * NEVER sends its own probe requests. It measures throughput from the REAL
 * generations that already flow through the provider, and only acts on
 * genuinely-completed, sufficiently-large slow generations.
 */

import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from "./types.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  /**
   * Throughput threshold in tokens/second. Generations below this are
   * considered "slow". Default: 20 (baseline is ~100 tok/s; 20 is clearly
   * degraded).
   */
  thresholdTps?: number;

  /**
   * Number of consecutive slow generations required before triggering a
   * reload. Default: 2 (avoids acting on a single noisy sample).
   */
  consecutiveSlow?: number;

  /**
   * Minimum completion_tokens for a generation to be evaluated. Tiny
   * generations have noisy tps and should not trigger a reload.
   * Default: 64.
   */
  minTokens?: number;

  /**
   * Injectable reload action. Called with the model string when the slow
   * threshold is crossed. Default: runs `ollama stop <model>` via Bun.spawn.
   * Tests MUST pass a fake reload — never the real one.
   */
  reload?: (model: string) => Promise<void>;

  /**
   * Injectable clock (milliseconds). Default uses performance.now().
   * Tests pass a fake clock so wall-time is fully deterministic.
   */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Default reload action (real Ollama unload)
// ---------------------------------------------------------------------------

async function defaultReload(model: string): Promise<void> {
  const proc = Bun.spawn(["ollama", "stop", model], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

// ---------------------------------------------------------------------------
// WatchdogProvider
// ---------------------------------------------------------------------------

export class WatchdogProvider implements Provider {
  private readonly inner: Provider;
  private readonly thresholdTps: number;
  private readonly consecutiveSlow: number;
  private readonly minTokens: number;
  private readonly reload: (model: string) => Promise<void>;
  private readonly now: () => number;

  /** Consecutive slow-generation counter. Reset to 0 on any fast generation. */
  private slowCount = 0;

  constructor(inner: Provider, opts: WatchdogOptions = {}) {
    this.inner = inner;
    this.thresholdTps = opts.thresholdTps ?? 20;
    this.consecutiveSlow = opts.consecutiveSlow ?? 2;
    this.minTokens = opts.minTokens ?? 64;
    this.reload = opts.reload ?? defaultReload;
    // Never call Date.now() or performance.now() directly in method bodies —
    // always use this.now() so tests can inject a fake clock.
    this.now = opts.now ?? (() => performance.now());
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startMs = this.now();
    // Delegate to inner provider. If it throws, propagate immediately and do
    // NOT count the call — a failed/aborted call is not a throughput sample.
    const result = await this.inner.complete(req);
    const wallMs = this.now() - startMs;

    const completionTokens = result.usage?.completionTokens ?? 0;

    // Only evaluate successful completions with enough tokens to be meaningful.
    if (completionTokens >= this.minTokens) {
      const tps = completionTokens / (wallMs / 1000);

      if (tps < this.thresholdTps) {
        this.slowCount++;
        if (this.slowCount >= this.consecutiveSlow) {
          this.slowCount = 0;
          process.stderr.write(
            `[watchdog] throughput degraded: ${tps.toFixed(1)} tok/s (threshold ${this.thresholdTps}) — reloading model ${req.model}\n`,
          );
          await this.reload(req.model);
        }
      } else {
        // Fast generation — reset consecutive counter.
        this.slowCount = 0;
      }
    }
    // If completionTokens < minTokens: ignore entirely (do not reset counter,
    // do not increment counter — tiny gens are invisible to the watchdog).

    return result;
  }

  async *stream(req: CompletionRequest): AsyncIterableIterator<StreamChunk> {
    // Stream is pass-through; throughput measurement only applies to complete().
    yield* this.inner.stream(req);
  }
}

// ---------------------------------------------------------------------------
// Conditional wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps `provider` in a WatchdogProvider when enabled, or returns it
 * unchanged.
 *
 * Enabled by default. Disable by setting `SMALLCODE_WATCHDOG=0`.
 */
export function maybeWrapWatchdog(provider: Provider, opts?: WatchdogOptions): Provider {
  const flag = process.env["SMALLCODE_WATCHDOG"];
  const enabled = flag !== "0";
  if (!enabled) return provider;
  return new WatchdogProvider(provider, opts);
}
