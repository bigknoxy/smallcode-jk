import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { debounce } from "../src/debounce";

beforeEach(() => {
  // Use Bun's built-in fake timers
  // @ts-ignore
  globalThis.__originalSetTimeout = globalThis.setTimeout;
  // @ts-ignore
  globalThis.__originalClearTimeout = globalThis.clearTimeout;
});

afterEach(() => {
  // @ts-ignore
  if (globalThis.__originalSetTimeout) {
    // @ts-ignore
    globalThis.setTimeout = globalThis.__originalSetTimeout;
    // @ts-ignore
    globalThis.clearTimeout = globalThis.__originalClearTimeout;
  }
});

test("does not call fn immediately", () => {
  const calls: number[] = [];
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  // Intercept setTimeout to capture the timer
  const origSetTimeout = globalThis.setTimeout;
  // @ts-ignore
  globalThis.setTimeout = (cb: () => void, delay: number) => {
    pendingTimeout = origSetTimeout(cb, delay);
    return pendingTimeout;
  };

  const fn = (n: number) => calls.push(n);
  const debounced = debounce(fn, 100);

  debounced(42);
  // Clear the pending timer before it fires
  if (pendingTimeout !== null) clearTimeout(pendingTimeout);

  expect(calls).toEqual([]);
});

test("calls fn once after delay with last args", async () => {
  const calls: number[] = [];
  const fn = (n: number) => calls.push(n);
  const debounced = debounce(fn, 20);

  debounced(1);
  debounced(2);
  debounced(3);

  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(calls).toEqual([3]);
});

test("resets timer on each call", async () => {
  const calls: number[] = [];
  const fn = (n: number) => calls.push(n);
  const debounced = debounce(fn, 30);

  debounced(1);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  debounced(2);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  // Only 15ms since last call — should NOT have fired yet
  expect(calls).toEqual([]);

  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  // Now 30ms since last call — should have fired once with arg 2
  expect(calls).toEqual([2]);
});
