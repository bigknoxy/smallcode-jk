#!/usr/bin/env bun
/**
 * Live smoke for the throughput watchdog. Forces thresholdTps absurdly high so
 * every real generation counts as "slow" — after consecutiveSlow gens the real
 * `ollama stop <model>` reload should fire, and the next gen should still
 * succeed (model reloads). Proves the actual stop+reload path the unit tests
 * mock out. Runs 3 short generations against the live Ollama. SERIAL — do not
 * run alongside any other Ollama job.
 */
import { OpenAICompatibleClient } from "../src/provider/openai-client.ts";
import { WatchdogProvider } from "../src/provider/watchdog.ts";

const MODEL = process.env["SMALLCODE_MODEL"] ?? "vibethinker-3b";
const client = new OpenAICompatibleClient({
  baseUrl: process.env["SMALLCODE_BASE_URL"] ?? "http://localhost:11434/v1",
  apiKey: "none",
  timeoutMs: 180_000,
});

let reloadCount = 0;
const wd = new WatchdogProvider(client, {
  thresholdTps: 99_999, // force every gen to look slow
  consecutiveSlow: 2,
  minTokens: 1, // count even tiny gens
  reload: async (model: string) => {
    reloadCount++;
    process.stderr.write(`\n>>> WATCHDOG FIRED: ollama stop ${model} (reload #${reloadCount})\n`);
    const proc = Bun.spawn(["ollama", "stop", model], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  },
});

for (let i = 1; i <= 3; i++) {
  const t0 = performance.now();
  const res = await wd.complete({
    model: MODEL,
    messages: [{ role: "user", content: `Reply with one short sentence. (${i})` }],
    temperature: 0.6,
    top_p: 0.95,
    max_tokens: 40,
  });
  const ms = performance.now() - t0;
  const toks = res.usage?.completionTokens ?? 0;
  process.stderr.write(
    `gen ${i}: ${toks} tok in ${(ms / 1000).toFixed(1)}s = ${(toks / (ms / 1000)).toFixed(1)} tok/s  reloads=${reloadCount}\n`,
  );
}

process.stderr.write(
  `\nRESULT: ${reloadCount >= 1 ? "PASS — watchdog fired real ollama stop and gens recovered" : "FAIL — watchdog never fired"}\n`,
);
