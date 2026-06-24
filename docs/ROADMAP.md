# smallcode — Roadmap to the Goal

**Goal:** a coding harness that makes a small *local* model produce real, correct, shippable code. If a 3B-class local model + this harness yields solid coding output, that is a game changer — capable coding fully offline/private. The bet: **harness design, not model size, unlocks usable coding.**

Two tracks:
- **(I) Make the harness gold-standard at single-task coding** — close the current accuracy gaps.
- **(II) Prove the thesis and extend to real repositories.**

Status at authoring (2026-06-23): in-house suite pass@1 **0.96**; HumanEval-TS full-agent-loop **capability pass@1 ~0.87** (timeout-excluded), pass@N(any)=1.0 on the early subset. Two gaps remain: **variance** (temp=1.0 → pass^k < pass@1) and **~8 systematic spec-misread traps** (same_chars, encrypt, count_nums, odd_count, sort_array, fix_spaces, prod_signs, is_nested).

This roadmap is the synthesis of four parallel research threads (capability techniques, benchmark strategy, real-repo architecture, model/serving frontier). Citations inline.

---

## NOW — bank the model-agnostic capability wins (≈1 week)

No model switch required. Attacks our exact two gaps.

1. **Oracle-verified Best-of-N retry** (1–2d). Wrap the loop in N=3 outer samples with a temperature sweep **[0.7, 1.0, 1.3]**; first solution that goes green on `bun test` wins. Because pass@N(any)=1.0 on our subset, this provably ~closes the variance gap. Also neutralizes the run-to-run timeout-variance noise. Evidence: Budget-Reallocation +15% with unit-test selection ([2404.00725](https://arxiv.org/abs/2404.00725)); S\* — a 3B + S\* surpasses GPT-4o-mini ([2502.14382](https://arxiv.org/abs/2502.14382)).
2. **AlphaCodium-style pre-solve in `planTask`** (2–3d). Before any code: restate spec as bullets → annotate each provided example ("given X, expect Y, because Z") → **self-generate 4–6 edge-case test I/O pairs**. Highest leverage on the trap-fails (forces confronting set-vs-multiset, negative-digit, output-format misreads). Self-tests are *supplementary hints only*; `bun test` stays sole arbiter. Evidence: AlphaCodium 19%→44% pass@5 ([2401.08500](https://arxiv.org/abs/2401.08500)); spec-extraction prompting 52%→85% on spec verification ([2508.12358](https://arxiv.org/html/2508.12358v1)).
3. **Strategy-seeded diversity** (1d). On retry, rotate explicit strategy prefixes ("solve with a set" / "with a loop" / "step through the examples first"). Breaks correlated misreads that token-temperature noise cannot. Evidence: interpretation diversity > model diversity ([2507.21168](https://arxiv.org/pdf/2507.21168)); temp diversity +7.3 ([2510.02611](https://arxiv.org/abs/2510.02611)).
4. **Structured failure feedback + stall→redraft** (1d). Feed the exact failing assertion + actual-vs-expected; after 2 stuck repairs on the same assertion, trigger full redraft (clear history, fresh draw). Evidence: self-repair only wins when feedback is diagnostic ([2306.09896](https://arxiv.org/abs/2306.09896)); SELF-REDRAFT ([2511.02854](https://arxiv.org/abs/2511.02854)).
5. **Skip** learned PRM and full MCTS — we have a perfect test oracle; those exist to approximate one ([T1 2504.04718](https://arxiv.org/abs/2504.04718)).

## NOW+ — infra: the long-run slowdown fix (agreed)

Root cause: llama.cpp KV-cache fragmentation + KV-not-freed over a 10h marathon → 105→0.5 tok/s; `ollama stop` (unload/reload) restores instantly. Keep **num_ctx=32K** (real coding needs it).

6. Set `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q8_0` (halves KV VRAM, ~0 quality loss). Add a **tok/s watchdog**: measure throughput/request, auto stop+reload when below ~30% of session-start baseline. Backstop: periodic reset every ~25 problems. Plus **stable static prefix** (never prepend dynamic content — KV-cache hit ~2s vs miss ~111s) and **observation masking** over old tool outputs (beats LLM summarization for coding). Evidence: Ollama #16336/#10114; JetBrains context-management (Dec 2025).

---

## NEXT — prove it honestly (≈2–3 weeks)

HumanEval is saturated (frontier 95–97%) and contaminated (in training data). Upgrade the claim.

7. **HumanEval+ / MBPP+ (EvalPlus, TS via MultiPL-E)** — honest edge-case hardening of the current number. Low cost. ([EvalPlus](https://evalplus.github.io/))
8. **LiveCodeBench-TS (Multi-LCB)** — **primary headline, contamination-resistant** (time-split by release date). Target: 3B-local approaching Qwen2.5-Coder-7B's 37.6%. ([2403.07974](https://arxiv.org/html/2403.07974v2), [Multi-LCB 2606.20517](https://arxiv.org/html/2606.20517v1))
9. **Harness-lift ablation (the thesis proof)** — same model: raw → +test-feedback → +retry loop → +full harness. Publish the delta table. Without this, reviewers credit the model, not the harness. ([Harness-Bench 2605.27922](https://arxiv.org/html/2605.27922v1))
10. **Multi-model bake-off on the SAME harness** — settle the model question with data, not a model card. Run **Qwen2.5-Coder-3B + Qwen2.5-Coder-7B + Qwen3-8B + VibeThinker-3B (control)** through the identical harness. Same Qwen lineage = minimal confounds. Either outcome is gold: harness lifts weak models near strong → thesis proven; Qwen3-8B dominates → switch with evidence. Also test **non-thinking vs reasoning** here (Thread D: think-token overhead is likely dead weight when the harness is the verifier — [2604.00824](https://arxiv.org/html/2604.00824)).

## LATER — real repositories (≈2–4 weeks, phased)

Evolve from single-file stub to real multi-file repos. Keep the two confirmed strengths: **full-file edits for small files** and the **`bun test` oracle**.

11. **Repo map** (regex-first → tree-sitter later) + windowed `read_file(offset,limit)` + `search_files(pattern)` — replaces stub-as-context; ~10% of context budget as a signature-only outline. ([aider repo map](https://aider.chat/2023/10/22/repomap.html))
12. **Edit-format gating by file size** — full-file ≤~200 lines (confirmed 3B strength: Qwen2.5-Coder-3B 39% whole-format, no 3B does diffs reliably); `patch_function(path,start,end,new_content)` applied deterministically for large files (no LLM diff parsing). ([aider edit formats](https://aider.chat/docs/more/edit-formats.html))
13. **Multi-file coordination** — plan emits dependency-ordered file manifest → one-file-per-turn → per-file `tsc --noEmit` gate → git checkpoint + revert-on-failure. ([SWE-agent ACI](https://swe-agent.com/0.7/background/aci/))
14. **Tiered oracle** — T0 syntax → T1 tsc → T2 lint → T3 build → T4 existing tests → T5 self-tests; plus a **test-file-mutation guard** (block the model from editing tests to fake green). Keep `bun test` as the gold top tier.
15. **Tool surface** ~8 tools (read/write/patch/search/run_command/run_tests/think/finish), error-recovery prompt injection, session-level turn budget.

---

## Key judgment call — the VibeThinker question

Thread D recommends switching to Qwen3-8B (VibeThinker's model card: *"not trained on tool-calling or agent-based programming… do not recommend for autonomous coding agents"*). **Recommendation: do not switch reflexively.** Our harness already reached 0.87 *by routing around* that weakness (full-file format exists precisely because the 3B fails at diffs). The rigorous move is **step 10's bake-off** — one experiment that both answers "which model" and delivers the thesis proof. VibeThinker stays as the control that demonstrates domain-fit matters.

## Immediate post-run sequence
1. `scripts/rerun-timeouts.ts` with fresh Ollama → clean final HumanEval-TS number (separate infra-timeouts from genuine fails).
2. Build **step 1 (oracle-verified Best-of-N)** — biggest single win; also retro-fixes this run's variance.

## Serving / quantization notes (Thread D)
- Short term: stay on Ollama + KV flags above. Medium term: evaluate llama.cpp `llama-server` for control (`-fa 1 --cache-type-k q8_0 --cache-type-v q8_0 -c <ctx> --mlock`). Avoid raw `mlx-lm` for unattended runs (unbounded KV → crashes) until `--max-kv-size` is battle-tested.
- Quant sweet spot: **Q6_K** model weights, **q8_0** KV cache (separate flag). Avoid Q4_K_M for an agentic harness where edit-format precision matters.

---

*Sources are linked inline. This roadmap integrates four research threads run 2026-06-23. Update as phases complete.*
