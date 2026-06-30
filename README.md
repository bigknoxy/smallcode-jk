# smallcode

[![CI](https://github.com/bigknoxy/smallcode-jk/actions/workflows/ci.yml/badge.svg)](https://github.com/bigknoxy/smallcode-jk/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/bigknoxy/smallcode-jk)](https://github.com/bigknoxy/smallcode-jk/releases)
[![License: MIT](https://img.shields.io/github/license/bigknoxy/smallcode-jk)](#license)
[![Bun](https://img.shields.io/badge/Bun-1.x-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)

> Agentic coding for small, local models. Designed for small local models: qwen2.5-coder:3b/7b (recommended), VibeThinker-3B (origin baseline), and any OpenAI-compatible endpoint.

smallcode wraps 3B–14B class models in scaffolding that compensates for their weaknesses — format fragility, weak long context, high output variance — and amplifies their strengths: verifiable reasoning on self-contained tasks. Unlike Aider, Claude Code, and Goose, which assume a frontier model that can hold arbitrary context and reason reliably, smallcode inverts the approach: minimize context, externalize state, constrain output format, decompose tasks, verify deterministically, and sample best-of-N.

[Full architecture diagram →](docs/architecture.html)

---

## Quickstart

### Prerequisites

- **[Bun](https://bun.sh)** (JavaScript runtime + package manager) — `curl -fsSL https://bun.sh/install | bash`
- **[Ollama](https://ollama.com/download)** (local model server) — then pull the model:
  ```bash
  ollama pull qwen2.5-coder:3b
  # or: ollama pull weiboai/vibethinker-3b  # origin baseline
  ollama serve   # default: http://localhost:11434
  ```

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/bigknoxy/smallcode-jk/main/install.sh | sh
```

This installs smallcode to `~/.smallcode` and writes a wrapper to `~/.local/bin/smallcode`.
If `~/.local/bin` is not on your `PATH`, the installer prints the line to add to your shell config.

### Verify, update, uninstall

```bash
smallcode --version   # prints: smallcode v1.3.0
smallcode update      # re-downloads latest release (or SMALLCODE_TARBALL) and reinstalls
smallcode uninstall   # dry-run: shows what would be removed
smallcode uninstall --yes   # actually removes ~/.smallcode and the wrapper
```

### Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `SMALLCODE_HOME` | `~/.smallcode` | Where smallcode source lives |
| `SMALLCODE_BIN_DIR` | `~/.local/bin` | Where the `smallcode` wrapper is written |
| `SMALLCODE_TARBALL` | — | Local path or URL; skips the GitHub release query |

---

## Manual quick start (dev / no install)

**1. Install Ollama and pull a model**

```bash
# Install Ollama: https://ollama.com/download
ollama pull qwen2.5-coder:3b
# or: ollama pull weiboai/vibethinker-3b  # origin baseline
ollama serve   # default: http://localhost:11434
```

**2. Create a config file**

```bash
# In your project directory:
cat > smallcode.config.json << 'EOF'
{
  "config": {
    "provider": {
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "none",
      "timeoutMs": 120000
    },
    "activeModel": "qwen2.5-coder:3b",
    "sandbox": {
      "enabled": true,
      "requireApproval": true,
      "allowedCommands": ["bun", "tsc", "biome", "git"],
      "networkAccess": false
    },
    "eval": {
      "suitesDir": "evals/suites",
      "transcriptsDir": "evals/transcripts",
      "defaultTrials": 1
    },
    "maxTurns": 15,
    "bestOfN": 1
  }
}
EOF
```

**3. Run a coding task**

```bash
bun run index.ts run --task "Add input validation to src/api/handler.ts" --repo .
```

---

## Serving models

### Ollama (recommended)

```bash
# Pull the recommended model
ollama pull qwen2.5-coder:3b
# or: ollama pull weiboai/vibethinker-3b  # origin baseline

# Serve on default port 11434
ollama serve

# Verify it is running
curl http://localhost:11434/v1/models
```

The Ollama OpenAI-compatible endpoint is at `http://localhost:11434/v1`. Use this as `provider.baseUrl` in your config.

**Long sessions (recommended):** For sessions longer than ~1 hour, launch Ollama via the provided script instead of `ollama serve`. It sets `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`, which halve KV-cache VRAM usage and slow the llama.cpp KV-cache fragmentation that causes throughput decay on Apple Silicon:

```bash
chmod +x scripts/ollama-serve.sh
scripts/ollama-serve.sh   # drop-in replacement for `ollama serve`
```

The throughput watchdog (`SMALLCODE_WATCHDOG`, on by default) also detects decay automatically and unloads/reloads the model mid-session, but starting with the optimised flags defers the first decay event considerably.

### llama.cpp

```bash
# Build llama.cpp, then (example with qwen2.5-coder:3b GGUF):
./llama-server \
  --model models/Qwen2.5-Coder-3B-Instruct-Q8_0.gguf \
  --port 8080 \
  --ctx-size 32768
# VibeThinker-3B (origin baseline): use VibeThinker-3B-Q4_K_M.gguf, --ctx-size 65536
```

Set `provider.baseUrl` to `http://localhost:8080/v1`.

### LM Studio

1. Download and open LM Studio.
2. Search for `Qwen/Qwen2.5-Coder-3B-Instruct` (recommended) or `WeiboAI/VibeThinker-3B` (origin baseline) and download the GGUF.
3. Start the local server (default port: 1234).
4. Set `provider.baseUrl` to `http://localhost:1234/v1`.

### vLLM / SGLang

```bash
# vLLM (qwen — recommended)
vllm serve Qwen/Qwen2.5-Coder-3B-Instruct \
  --port 8000 \
  --max-model-len 32768

# SGLang (qwen — recommended)
python -m sglang.launch_server \
  --model-path Qwen/Qwen2.5-Coder-3B-Instruct \
  --port 30000

# VibeThinker-3B (origin baseline): replace with WeiboAI/VibeThinker-3B
```

All three expose an OpenAI-compatible `/v1/chat/completions` endpoint. Point `provider.baseUrl` at whichever you use.

---

## Configuration

`smallcode.config.json` (or `.smallcode.json`) is read from the current working directory. The file has a required `config` key and an optional `models` key for registering custom model profiles.

```json
{
  "config": {
    "provider": {
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "none",
      "timeoutMs": 120000
    },
    "activeModel": "qwen2.5-coder:3b",
    "sandbox": {
      "enabled": true,
      "requireApproval": true,
      "allowedCommands": ["bun", "tsc", "biome", "git"],
      "networkAccess": false
    },
    "eval": {
      "suitesDir": "evals/suites",
      "transcriptsDir": "evals/transcripts",
      "defaultTrials": 1
    },
    "maxTurns": 15,
    "bestOfN": 1
  },
  "models": []
}
```

### Config field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `config.provider.baseUrl` | string (URL) | — | Base URL of your OpenAI-compatible endpoint. **Required.** |
| `config.provider.apiKey` | string | `"none"` | API key. Use `"none"` for local endpoints that don't require auth. |
| `config.provider.timeoutMs` | number | `120000` | Per-request timeout in milliseconds. |
| `config.activeModel` | string | — | Model profile ID to use. Must match a built-in profile or a custom entry in `models`. **Required.** |
| `config.sandbox.enabled` | boolean | `true` | Enable the command sandbox. Disable only for trusted environments. |
| `config.sandbox.requireApproval` | boolean | `true` | **Diff-review-before-write**: in interactive runs (`run` / `chat`), the agent shows each proposed edit (path + format + new content) and asks `Apply this edit? [y/N]` before writing — default **N**, so nothing lands without your OK. A rejected edit writes nothing and the model is told so. Non-interactive/eval runs ignore it (no hook) and apply unconditionally. |
| `config.sandbox.allowedCommands` | string[] | `["bun","tsc","biome","git"]` | Allowlist of command basenames the agent may execute. |
| `config.sandbox.networkAccess` | boolean | `false` | Whether agent-run commands may make network requests. |
| `config.eval.suitesDir` | string | `"evals/suites"` | Directory where eval suite YAML/JSON files live. |
| `config.eval.transcriptsDir` | string | `"evals/transcripts"` | Where session transcripts are written. |
| `config.eval.defaultTrials` | number | `1` | Number of trials per eval task when not overridden. |
| `config.maxTurns` | number | `15` | Hard cap on agent turns per session (1–50). |
| `config.bestOfN` | number | `1` | Sample N candidate responses per turn, keep the one that passes the most checks (1–10). |
| `models` | ModelProfile[] | `[]` | Additional model profiles to register alongside the built-ins. |

### Environment variable overrides

| Variable | Overrides |
|---|---|
| `SMALLCODE_BASE_URL` | `config.provider.baseUrl` |
| `SMALLCODE_MODEL` | `config.activeModel` |

---

## CLI reference

All commands are invoked via `bun run index.ts <command>` (or a compiled `smallcode` binary).

| Command | Flags | Description |
|---|---|---|
| `run` | `--task <string>` `--repo <path>` `--config <path>` `--model <id>` `--max-turns <n>` `--best-of-n <n>` `--escalation <m1,m2,..>` | Run the agent on a coding task inside the given repo directory. Ends with a diff summary + how to review/undo. |
| `chat` | `--repo <path>` `--model <id>` `--config <path>` | Interactive multi-task session — keeps the repo index + model warm across tasks. Slash-commands: `/add` `/drop` `/files` (pin context), `/diff` `/undo` (review/revert), `/model` `/clear` `/help` `/exit`. Any other line is a coding task. |
| `diff` | `--repo <path>` | Show what the agent changed (unified diff + any new files). |
| `undo` | `--repo <path>` `--yes` | Revert the agent's changes (restore tracked files + delete its new files). **Dry-run without `--yes`** — prints what it would discard; committed history is never touched. |
| `eval run` | `--suite <path>` `--model <id>` `--config <path>` `--trials <n>` `--transcripts-dir <path>` `--fixtures-root <path>` `--output json\|text` | Run an eval suite and report pass@1, pass@k, and partial scores. Exits 1 if any tasks fail. |
| `eval gate` | `--suite <path>` `--baseline <path>` `--model <id>` `--threshold <0-1>` | Regression gate: fail if pass@1 drops below `threshold` versus baseline snapshot. For use in CI. |
| `config init` | `--out <path>` | Write a starter `smallcode.config.json` to the given path. |
| `config list-models` | | List all registered model profiles (built-ins + any custom entries from config). |

---

## Architecture

[See the full architecture diagram →](docs/architecture.html)

smallcode is organized into eight cooperating pillars:

1. **Provider layer** (`src/provider/`) — thin OpenAI-compatible HTTP client. Handles completions, streaming, retries, and `ProviderError` with `retryable` semantics. Decoupled from model specifics so any compatible endpoint works.

2. **Reasoning handler** (`src/reasoning/`) — strips and logs `<think>…</think>` reasoning traces before the answer text reaches downstream parsers. Keeps the model's chain-of-thought out of the edit parser and tool call parser.

3. **Context engine** (`src/context/`) — builds a minimal `ContextBundle` from a `RepoMap` of symbols and file chunks. Respects a token budget so the model never sees more than its context window can hold. Truncation is explicit and logged.

4. **Edit protocol** (`src/edit/`) — models emit edits as full-file rewrites (`FILE: <path>` followed by a fenced code block with the complete corrected file) as the primary format, with `SEARCH/REPLACE` blocks and JSON patches as fallbacks. The parser (`parseFullFile`) produces `EditBlock` values; the applier overwrites the whole file for full-file rewrites or performs exact-match replacement for SEARCH/REPLACE, and returns a unified diff. Failed matches surface `not_found` or `ambiguous` status for self-correction.

5. **Agent loop** (`src/agent/`) — drives the per-turn cycle: fetch context → build prompt → call model → parse reasoning → parse edits → apply edits → execute tool calls (`run_tests`, `run_command`, `read_file`) → run `bun test` as a deterministic pass-oracle → **early-stop** if tests pass (exitCode 0, zero failures), locking the solution and preventing later turns from clobbering it → advance goal → persist state. State is written to `.smallcode/state.json` after every turn so sessions are resumable. Real test output (up to 600 chars) is fed back into the next turn for self-debug.

6. **Verification loop** (`src/verify/`) — runs a configurable checker suite (format, lint, typecheck, test) after edits are applied. On failure, feeds the truncated output back to the model as a self-correction prompt. `maxCorrectionIterations` bounds the retry depth.

7. **Eval harness** (`src/eval/`) — loads YAML/JSON task suites, runs trials, grades outcomes with deterministic tests, static analysis, or LLM rubrics, and computes pass@1, pass@k, and partial scores. Transcripts are written to disk for inspection.

8. **Self-improvement loop** (`src/improve/`) — logs every session, promotes failed runs to candidate eval tasks, tracks `MetricsSnapshot` history, runs regression gates, and supports A/B comparison of system prompt variants.

---

## Model compatibility

smallcode works with any model served on an OpenAI-compatible `/v1/chat/completions` endpoint.

| Model ID | Context window | Temperature | Reasoning tags | Notes |
|---|---|---|---|---|
| `qwen2.5-coder:3b` | 32,768 tokens | 0.7 | — | **Recommended.** Apache-2.0. No think-only spiral. 30-60x faster than VibeThinker. realrepo pass@1: 0.52. Aces klona tasks where VibeThinker scored 0/10. |
| `qwen2.5-coder:7b` | 32,768 tokens | 0.7 | — | **Recommended (larger).** Apache-2.0. realrepo pass@1: 0.73. Bigger model arm of the 3-way comparison. |
| `qwen2.5-coder-14b` | 131,072 tokens | 0.7 | — | Highest quality of built-in profiles. Supports JSON schema and grammar-constrained output. |
| `vibethinker-3b` | 65,536 tokens | 1.0 | `<think>` / `</think>` | Origin baseline. MIT license. Produced the 0.828 HumanEval-TS result. Think-only spiral on some real-lib bugs (0/10 klona). Still supported via `SMALLCODE_MODEL=vibethinker-3b`. |

Swap the active model per-run without editing config via `SMALLCODE_MODEL` (e.g. `SMALLCODE_MODEL=qwen2.5-coder:3b`). Custom models can be registered in the `models` array of your config file using the `ModelProfile` schema.

### Why qwen?

We built smallcode on VibeThinker-3B — it produced the 0.828 HumanEval-TS baseline and revealed a "think-only" reasoning spiral: the model burns its generation budget inside `<think>`, emits no code, scoring 0/10 on some real-lib bugs. We confirmed the HARNESS, not the model, does the work by swapping to qwen2.5-coder:3b — same 3B size, no think-only, 30-60x faster — and rerunning the realrepo suite: qwen-3b 0.52, qwen-7b 0.73. VibeThinker-3B remains the origin story and is still fully supported.

---

## Eval-driven development

The eval subsystem is the feedback mechanism for improving smallcode's prompts and scaffolding against small models.

**Suites** are YAML or JSON files in `evals/suites/` that define a list of `EvalTask` objects. Each task has a natural-language description, a setup block (repo fixture or inline files), one or more graders, and optional tags like `regression` or `capability`.

**Grader types:**
- `deterministic_tests` — runs `bun test` (or a custom command) and checks that the specified test files pass.
- `static_analysis` — runs tools like `biome` or `tsc` and expects exit code 0.
- `llm_rubric` — uses a secondary model call to score the output against a rubric markdown file.

**Metrics:**
- `pass@1` — probability of success on a single trial. This is the headline metric.
- `pass^k` — probability that all k trials pass. Measures consistency under the model's sampling distribution.
- `partial score` — fraction of graders that pass, giving partial credit for close attempts.

**The self-improvement loop:**

```
session fails → session logger writes SessionLogEntry
             → task extractor creates CandidateTask from transcript
             → promoter adds it to a regression suite
             → eval run measures pass@1 on the new suite
             → regression gate blocks CI if pass@1 drops below threshold
             → A/B compare system prompt variants to find improvements
             → repeat
```

The metrics store tracks `MetricsSnapshot` history per suite, enabling trend analysis and catching regressions introduced by prompt changes.

---

## License

MIT

<!-- agent-skills:doc-keeper:start -->
## Reference (auto-tracked by doc-keeper)

### Environment Variables
- `SMALLCODE_DRY_RUN`: _(add description)_
- `SMALLCODE_EVAL_MAX_TURNS`: _(add description)_
- `SMALLCODE_EVAL_K`: _(add description)_
- `SMALLCODE_HE_LIMIT`: _(add description)_
- `SMALLCODE_HE_OFFSET`: _(add description)_
- `SMALLCODE_HE_K`: _(add description)_
- `SMALLCODE_HE_MAX_TURNS`: _(add description)_
- `SMALLCODE_HE_TIMEOUT_MS`: _(add description)_
- `SMALLCODE_RERUN_TIMEOUT_MS`: _(add description)_
- `SMALLCODE_HE_CACHE`: _(add description)_
- `SMALLCODE_SMOKE_OFFSET`: _(add description)_
- `SMALLCODE_SMOKE_N`: _(add description)_
- `SMALLCODE_SMOKE_MAX_TURNS`: _(add description)_
- `SMALLCODE_DISCIPLINE`: _(add description)_
- `SMALLCODE_PRESOLVE`: _(add description)_
- `SMALLCODE_SUITE`: eval suite for `run-baseline.ts` — bare name under `evals/suites/` or an explicit path (default `capability`).
- `SMALLCODE_TARGET_PIN`: pin the edit-target file as an undroppable whole chunk + size-gate the edit format (default on; set `0` to disable, e.g. for the pre-A baseline).
- `SMALLCODE_MAX_TOKENS`: override the model's `max_tokens` for a `run-baseline.ts` run (default = registry value, 4096). Cause-attack A/B for think-only truncation; larger = more generation room but a smaller prompt budget (`num_ctx − max_tokens`).
- `SMALLCODE_TEMP`: override the model's sampling temperature for a `run-baseline.ts` run (default = registry value). Used to A/B whether lower temperature reduces reasoning spirals / variance.
- `SMALLCODE_EVAL_N`: sample count **n** — trials per task in a live `run-baseline.ts` run (default 10, falls back to `SMALLCODE_EVAL_K`). Decoupled from the reported k; larger n → tighter confidence intervals (~1/√n).
- `SMALLCODE_REPORT_KS`: comma list of k values to report pass@k for (default `1,2,3,5`). Each pass@k is reported with a 95% bootstrap CI; `n` is always added so `passAtK[n]` survives.
- `SMALLCODE_CI_SEED`: seed for the bootstrap-CI RNG (default fixed) so confidence intervals are reproducible across reruns of the same trial outcomes.
- `SMALLCODE_GRADER_RETRIES`: how many times the deterministic grader retries a transient **infra** error (lockfile/EAGAIN) that produced no test verdicts (default 1). Never retries a real test failure (a parsed `✗` blocks the retry).
- `SMALLCODE_DIFF_EDIT`: big-file PATCH editing uses a minimal SEARCH/REPLACE diff (changes only the buggy lines) instead of re-emitting the complete function. Size-gated — applies only to target functions ≥ `SMALLCODE_DIFF_MIN_FN` lines, where whole-function re-emission causes over-editing. **Default ON** (confirmed +0.17 OVERALL on edit-reliability); opt out with `SMALLCODE_DIFF_EDIT=0`.
- `SMALLCODE_DIFF_MIN_FN`: minimum target-function line span for `SMALLCODE_DIFF_EDIT` to use a diff (default `30`). Below it, whole-function PATCH is kept (small functions don't benefit and exact-match diffs add fragility).
- `SMALLCODE_MODEL`: override the active model id for a run (e.g. `qwen2.5-coder:3b`, `qwen2.5-coder:7b`, `vibethinker-3b`) — a cross-model A/B with no config edit.
- `SMALLCODE_GEPA_DRY_RUN`: run `scripts/gepa-run.ts` with the MockMutator + a stubbed runner — exercises the GEPA evolution loop with NO GPU and NO reflection-LLM calls (smoke/CI). Set `=1`.
- `SMALLCODE_GEPA_GENERATIONS`: number of GEPA evolution generations to run (default `3`). Each generation reflects on a Pareto parent's failures and scores one mutated candidate on the full train suite.
- `SMALLCODE_GEPA_TRIALS`: trials per task when scoring a GEPA candidate (default `5`). Higher = tighter per-task pass@1 but more GPU time.
- `SMALLCODE_GEPA_POP_CAP`: maximum Pareto-front size kept across generations (default `6`).
- `SMALLCODE_GEPA_MUTATE_PLANNER`: when `=1`, the reflective mutator also rewrites the planner prompt (default off — conservative; only the executor `system` prompt is mutated).
- `SMALLCODE_GEPA_REFLECT_MODEL`: **required for a live run** — model id of the STRONG reflection model that diagnoses failures and rewrites prompts (must resolve in the model registry). Optional overrides: `SMALLCODE_GEPA_REFLECT_BASE_URL`, `SMALLCODE_GEPA_REFLECT_API_KEY`, `SMALLCODE_GEPA_REFLECT_MAX_TOKENS` (fall back to the provider config).
- `SMALLCODE_PROMPTSET`: path to a JSON file (`{ prompts: { system, planner, reflection, skill? } }`) produced by a GEPA run (e.g. `evals/gepa-best.json`); when set, `run-baseline.ts` injects those prompts as the agent's `promptSet`, overriding the defaults — use for held-out A/B validation of a GEPA-evolved prompt.
- `SMALLCODE_GEPA_REFLECT_TIMEOUT`: per-request timeout (ms) for the reflection model only (defaults to the executor provider timeout, 180000). Raise it for a slow strong reflector (e.g. a 32B rewriting a full prompt from many transcripts) — otherwise the call times out and the mutator silently no-ops to the parent, degrading GEPA to noise.
- `SMALLCODE_BEST_OF_N`: run-level oracle-verified Best-of-N (default `1` = single-shot). When `>1`, each trial runs up to N independent full agent-loop attempts in a fresh env, temperature-swept around 1.0 in `[0.7, 1.3]` for diversity, and resolves on the FIRST attempt whose deterministic test grader goes green. The grader is a sound oracle, so any-attempt-green == solved with zero selection error — the reported `pass@1` IS the empirical `pass@N(any)`. The live table shows `BoN<N>@<avgAttemptsUsed>` (mean attempts spent per trial = cost) and the snapshot records `bestOfN` + `avgAttemptsUsed`.
- `SMALLCODE_TASK_FILTER`: comma-separated substrings; `run-baseline.ts` runs only suite tasks whose id contains ANY term (unset = whole suite). Lets you A/B a focused subset (e.g. the localization-hard realrepo tasks) without authoring a temp suite dir.
- `SMALLCODE_ESCALATION`: R1 model-escalation ladder for the **eval harness** (default OFF). Comma-separated model ids, cheapest first (e.g. `qwen2.5-coder:3b,qwen2.5-coder:3b,qwen2.5-coder:7b`). With `SMALLCODE_BEST_OF_N>1`, Best-of-N attempt `i` runs with `ladder[min(i, len-1)]` instead of the base model — and since BoN resolves on the FIRST oracle-green attempt, a run only pays for the bigger model on the residual the small model couldn't solve (zero selection error). All rungs share the local Ollama endpoint, so escalation stays fully offline — cap the ladder at the largest LOCAL model. The winning rung is recorded per trial. Ignored when BoN ≤ 1. The same ladder is available to the **CLI** — see *Escalation* below.
- `SMALLCODE_LOCALIZE`: R2 externalize-localization (experimental, default OFF). When `=1`, a failure whose stack trace reaches a SOURCE line (a runtime throw — not a value-mismatch, whose trace stops at the test line) surfaces a tight `## FAILURE LOCATION` window around that exact line, marked `⟵ FAILED HERE`, in the next prompt — handing the small model the `where` it cannot localize itself. Off → loop is byte-identical (clean A/B baseline). Pass-rate lift pending a throw-class A/B suite.
- `SMALLCODE_VALIDATE_EDIT`: R4 validate-before-commit guard, **ON by default**. Treats an edit that makes the test suite fail to LOAD/COMPILE (missing module, parse error) as a hard regression — even when the red-count drops because fewer tests ran — so the broken edit is reverted and the next prompt shows an actionable BUILD ERROR instead of a misleading "fewer failures = progress". Set `=0` to restore the old count-only behaviour (the A/B baseline arm).
- `POLYGLOT_EXERCISES`: comma-separated exercise names for `scripts/vendor-polyglot.ts` (R5) — overrides the curated default list when vendoring the Aider polyglot-benchmark JavaScript exercises into the `aider-polyglot` eval suite. Each is fetched, converted (stub + un-skipped spec + reference solution), and kept only if its stub is red and its solution green.
- `SMALLCODE_STATIC_CONFIDENCE`: oracle-free static-confidence ladder, **ON by default**. When a change is NOT covered by any test, the verifier cannot claim correctness — instead of a bare "unverified" it reports a deterministic grade: `broken` (a source file doesn't parse — a structural break caught with no test/tsconfig needed) → `parses` (every source file parses) → `type-clean` (also `tsc`-clean). A SAFETY signal, not a correctness one: a wrong operator parses + typechecks clean (`scripts/probe-confidence.ts` measures this — logic-blind, structural-safe). The grade also acts IN the loop: a `broken` edit on an untested repo is **reverted** (the R4 "never leave the repo broken" guard, generalized past tests), and the CLI reports the grade on any unverified end (finish OR max_turns), not just a bare "without solving". Set `=0` to skip it.
- `SC_SUITE` / `SC_N` / `SC_TASKS`: knobs for `scripts/probe-selfconsistency.ts` (the oracle-free self-consistency probe) — the suite to draw from, number of independent attempts per task, and comma-separated task-id substrings. Measurement-only; not used by the product runtime.
- `SWEBENCH_LIMIT`: how many SWE-bench-Lite instances `scripts/vendor-swebench.ts` ingests (and `scripts/run-swebench.ts` attempts). SWE-bench is **ingested** into runnable task descriptors here; **execution** needs a prepared per-instance Python env (the official Docker harness) — the runner clones + applies the test patch, then skips any instance whose deps aren't importable on this machine rather than report a fake 0.
- `SWEBENCH_WORK`: working dir where `scripts/run-swebench.ts` clones/caches SWE-bench repos at their `base_commit` (default `/tmp/swebench-work`).
<!-- agent-skills:doc-keeper:end -->

## Escalation — scale to your hardware

smallcode's default is a single small local model (e.g. `qwen2.5-coder:3b`) — runs on modest hardware, fully offline. With more hardware you can let a run **escalate** to bigger local models only when the small one can't crack a task, paying for the big model just on the residual.

It rides the Best-of-N seam: each attempt is independent and the run stops on the first oracle-green result, so a ladder spends the small model first and climbs only on failure.

```jsonc
// smallcode.config.json
{
  "activeModel": "qwen2.5-coder:3b",
  "bestOfN": 3,
  "escalation": ["qwen2.5-coder:3b", "qwen2.5-coder:7b", "gemma4:12b"]
}
```
```bash
# or per run
smallcode run "fix the failing test" --best-of-n 3 \
  --escalation qwen2.5-coder:3b,qwen2.5-coder:7b,gemma4:12b
```

- **Low-resource:** leave `escalation` empty (or `bestOfN: 1`) → just the 3b.
- **Bigger hardware:** add rungs as high as your box allows — `7b`, `gemma4:12b`, `qwen2.5-coder:32b`, anything in `smallcode config list-models` (the ladder is model-agnostic; every rung is local, one Ollama endpoint).
- Attempt `i` uses `ladder[min(i, len-1)]`, so a 3-rung ladder over `bestOfN: 5` reuses the top rung for the last attempts.
- **Safety:** CLI run-level Best-of-N resets the working tree between attempts, so it requires a **git repo with a clean working tree** — it refuses (with guidance) rather than risk clobbering uncommitted work. Losing attempts are rolled back; the winning attempt's edits stay.
