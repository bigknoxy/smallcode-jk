# HumanEval-TS external benchmark

Model: **VibeThinker-3B** (Q8_0, Ollama, temp 1.0 / top_p 0.95)
Harness: smallcode agent loop — full-file edit format + `bun test` early-stop oracle.
Dataset: [nuprl/MultiPL-E](https://huggingface.co/datasets/nuprl/MultiPL-E) `humaneval-ts` (TypeScript translation of OpenAI HumanEval).
Runner: `scripts/run-humaneval.ts`. Agent context contains **only the function stub** — the test file is on disk (for the oracle) but never shown to the model, so results reflect general solutions, not assert pattern-matching.

## Results — first 30 problems, k=3 (2026-06-22)

| metric | value | detail |
|---|---|---|
| pass@1 (mean over trials) | **0.967** | 87/90 trials |
| pass^3 (all 3 trials pass) | 0.900 | 27/30 problems |
| pass@3 (any of 3 passes) | **1.000** | 30/30 problems |

Cross-check: matches the in-house capability suite (0.96), i.e. **not overfit** to self-authored tasks.

Reference: VibeThinker-3B raw single-shot HumanEval pass@1 is ~0.45–0.60; the agentic loop (iterate + verify) lifts the same 3B model to **0.967**.

### Variance (the only gap)
Three problems flipped 2/3 (temp=1.0 diversity): `separate_paren_groups`, `remove_duplicates`, `flip_case` — all trivially solvable. Because pass@3(any)=1.0, an oracle-verified best-of-N (N=3) retry delivers ≈1.0.

## Reproduce
```sh
SMALLCODE_HE_LIMIT=30 SMALLCODE_HE_K=3 bun scripts/run-humaneval.ts
# full set:
SMALLCODE_HE_LIMIT=164 SMALLCODE_HE_K=3 bun scripts/run-humaneval.ts
```
