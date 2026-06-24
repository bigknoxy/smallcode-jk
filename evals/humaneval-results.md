# HumanEval-TS external benchmark

Model: **VibeThinker-3B** (Q8_0, Ollama, temp 1.0 / top_p 0.95)
Harness: smallcode agent loop — full-file edit format + `bun test` early-stop oracle.
Dataset: [nuprl/MultiPL-E](https://huggingface.co/datasets/nuprl/MultiPL-E) `humaneval-ts` (TypeScript translation of OpenAI HumanEval; 159 of 164 problems ship in TS).
Runner: `scripts/run-humaneval.ts`. Agent context contains **only the function stub** — the test file is on disk (for the oracle) but never shown to the model, so results reflect general solutions, not assert pattern-matching.

## Full 159-problem run, k=3 (2026-06-24)

| metric | value | detail |
|---|---|---|
| pass@1 (mean over trials) | **0.828** | 395/477 trials |
| pass^3 (all 3 trials pass) | 0.748 | 119/159 problems |
| pass@3 (any of 3 passes) | **0.906** | 144/159 problems |

This is the **clean** number: the full run was executed over ~16h during which Ollama's
KV-cache fragmented and generation decayed 105→0.5 tok/s, causing 50 trial timeouts
(infra, not wrong answers). Raw as-run pass@1 was 0.759; the 29 timeout-affected problems
were re-run with a fresh Ollama (`scripts/rerun-timeouts.ts`, cache-backed via
`scripts/cache-humaneval.ts`) and merged back. 17/29 recovered to 3/3, confirming those
failures were infra. The re-run **lowered** the optimistic arithmetic estimate (0.848) to
the measured 0.828 — because several problems assumed to be "trivial infra" (any_int,
check_dict_case, encode) are in fact genuine failures. Measuring beats hand-waving.

Reference: VibeThinker-3B raw single-shot HumanEval pass@1 is ~0.45–0.60; the agentic loop
(iterate + verify) lifts the same 3B model to **0.828 pass@1 / 0.906 solve-rate** on the
full TypeScript HumanEval.

### 15 genuine failures (the work-list)
All re-verified under healthy serving — real, not infra:
`same_chars` (set-vs-multiset), `encrypt` (rotation cipher), `any_int` (all-integers check),
`encode`, `check_dict_case`, `rounded_avg`, `count_nums` (negative digits), `odd_count`
(output-string format), `sort_array` (binary-ones sort key), `split_words`, `minPath` (grid),
`file_name_check`, `order_by_points`, `do_algebra`, `string_to_md5` (likely a harness gap —
needs `node:crypto`, not a capability limit).

These 15 are the targets for the roadmap (`docs/ROADMAP.md`): oracle-verified Best-of-N
(pass@3(any)=0.906 → N≥3 retry lifts toward ~0.91+) and AlphaCodium-style pre-solve
(spec restatement + self-generated edge tests) for the systematic spec-misread traps.

## Earlier — first 30 problems, k=3 (2026-06-22)
pass@1 0.967, pass^3 0.900, pass@3 1.000. The first 30 are the easy head of the set; the
full-159 number above is lower because it includes the harder tail. Cross-checks the in-house
capability suite (0.96).

## Infra note
Long local runs decay Ollama throughput (llama.cpp KV-cache fragmentation; Ollama
issues #16336/#10114). `ollama stop` (model unload/reload) restores speed instantly.
Mitigations queued: `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q8_0` + a tok/s
watchdog. See memory + `docs/ROADMAP.md`.

## Reproduce
```sh
bun scripts/cache-humaneval.ts          # one-time dataset cache (network-proof)
SMALLCODE_HE_LIMIT=30 SMALLCODE_HE_K=3 bun scripts/run-humaneval.ts
SMALLCODE_HE_LIMIT=164 SMALLCODE_HE_K=3 bun scripts/run-humaneval.ts   # full set
bun scripts/rerun-timeouts.ts /tmp/humaneval-full.log                  # clean infra timeouts
```
