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

### Your first fix

smallcode is fully local — no API key, no network calls beyond your Ollama server. Once Ollama is running (see Prerequisites) and `smallcode` is installed:

**1. Initialize a config in your project**

```bash
cd your-project
smallcode config init --model qwen2.5-coder:3b
```

Writes `smallcode.config.json` pointed at `http://localhost:11434/v1`, with `sandbox.requireApproval: true` (each edit is shown for a `y/N` in an interactive terminal — nothing lands without your OK) and the default escalation ladder `["qwen2.5-coder:3b", "qwen2.5-coder:7b"]` (climbs to 7b only if 3b's fix doesn't pass the test oracle). **Gotcha:** without `--model`, `config init` defaults to `vibethinker-3b` — pass `--model qwen2.5-coder:3b` for the recommended model.

**2. Point it at a repo with a failing test and let it fix that test**

```bash
smallcode fix --repo /path/to/repo
```

Runs your test command (default `bun test`); if it's already green, this is a no-op. If it's RED, smallcode derives a fix task from the failing output and drives the agent loop, stopping the moment the test oracle goes green — escalating 3b → 7b automatically if the small model can't solve it.

Or describe a task in your own words:

```bash
smallcode run "add input validation to src/api/handler.ts" --repo /path/to/repo
```

Success means the change was **oracle-verified**: the test suite (or, for untested code, a static-confidence grade) confirmed the fix, not just that the model claimed to be done.

**3. Review, and undo if needed**

```bash
smallcode diff --repo /path/to/repo         # see exactly what changed
smallcode undo --repo /path/to/repo         # dry-run: shows what would revert
smallcode undo --repo /path/to/repo --yes   # revert (only the agent's own edits — your own work is untouched)
```

In a non-interactive run (CI, piped, `--json`) there's no TTY to answer the approval prompt, so edits are applied with a one-time notice instead of blocking — review with `diff`/`undo` as above, or pass `--yes` to apply without the notice.

**4. Scale up (optional)** — the ladder above already escalates 3b → 7b on failure with zero flags. To use a different ladder or pin one model for a run: `--model <id>` (single model, no escalation) or `--escalation m1,m2,...` (override the config ladder). See [Escalation](#escalation--scale-to-your-hardware) below.

### Verify, update, uninstall

```bash
smallcode --version   # prints: smallcode v1.5.0
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
bun bin/smallcode.ts run "Add input validation to src/api/handler.ts" --repo .
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

All commands are invoked via `bun bin/smallcode.ts <command>` (or the installed `smallcode` binary).

| Command | Flags | Description |
|---|---|---|
| `run` | `<task description>` (positional) `--repo <path>` `--config <path>` `--model <id>` `--max-turns <n>` `--best-of-n <n>` `--escalation <m1,m2,..>` `--json` `--yes` | Run the agent on a coding task inside the given repo directory, e.g. `smallcode run "add input validation to src/api/handler.ts" --repo .`. Ends with a diff summary + how to review/undo. `--json` prints exactly one JSON line (`{ok, verified, status, model, turnsUsed, filesChanged, added, removed, reason}`) to stdout instead — for scripting/CI, exit code is unchanged (0 iff verified). |
| `fix` | `--repo <path>` `--test "<cmd>"` `--model <id>` `--best-of-n <n>` `--escalation <m1,m2,..>` `--max-turns <n>` `--json` | Test-driven auto-fix: runs the test command (default `bun test`); if GREEN, exits 0 immediately ("nothing to fix"); if RED, derives a task from the failing output and runs the SAME pipeline as `run`. The pre-commit / delegation primitive — point a hook or another agent at it and it either no-ops or drives the loop until tests pass (or gives up honestly). |
| `chat` | `--repo <path>` `--model <id>` `--config <path>` | Interactive multi-task session — keeps the repo index + model warm across tasks. Slash-commands: `/add` `/drop` `/files` (pin context), `/diff` `/undo` (review/revert), `/model` `/clear` `/help` `/exit`. Any other line is a coding task. |
| `diff` | `--repo <path>` | Show what the agent changed (unified diff + any new files). |
| `undo` | `--repo <path>` `--yes` | Revert **only** what the agent changed — a run records its own edits to `.smallcode/agent-changes.json`, so undo restores those tracked files + deletes those new files and **never touches your own uncommitted work**. **Dry-run without `--yes`**; committed history is never touched. |
| `eval run` | `--suite <path>` `--model <id>` `--config <path>` `--trials <n>` `--transcripts-dir <path>` `--fixtures-root <path>` `--output json\|text` | Run an eval suite and report pass@1, pass@k, and partial scores. Exits 1 if any tasks fail. |
| `eval gate` | `--suite <path>` `--baseline <path>` `--model <id>` `--threshold <0-1>` | Regression gate: fail if pass@1 drops below `threshold` versus baseline snapshot. For use in CI. |
| `config init` | `--out <path>` | Write a starter `smallcode.config.json` to the given path. |
| `config list-models` | | List all registered model profiles (built-ins + any custom entries from config). |

### Pre-commit / delegation: `run --json` + `fix`

Both are additive, machine-readable entry points for wiring smallcode into a hook, CI step, or another agent — no human in the loop required:

- `smallcode run "<task>" --json` — same agent loop, same exit code (0 iff oracle-verified green), but the human progress display is replaced by exactly one JSON line on stdout so a caller can parse the outcome without screen-scraping.
- `smallcode fix` — the "auto-fix the red build" primitive. It runs your test command first; if it's already green there's nothing to do (fast exit 0, no model call). If it's red, it builds the task automatically from the captured failing output and hands off to the exact same `run` pipeline (config, provider, model registry, Best-of-N, escalation ladder, `--json`) — so a pre-commit hook or CI step can just run `smallcode fix --json` and either get a no-op or a genuine attempt to make the suite pass, honestly reported either way. The anti-test-edit guard stays in force: the model may not edit tests to fake a green.

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
- `SMALLCODE_TARGET_LOCK`: drift **enforcement**, **ON by default**. Dogfooding showed a 7b model ignoring the prompt-level "## STAY ON TARGET" re-anchor and editing an unrelated file 7× in one run. When a confident single edit target is pinned (`context.targetFile`) AND the run is in fix-mode (the pre-loop test baseline was red), the loop hard-rejects any edit to a file other than the target on **both** write paths — `FILE:`/`PATCH:` blocks via `applyBatch(..., { targetPath })` (mirrors the existing anti-test-edit guard, `status: "error"`, nothing written) and `TOOL: write_file` (skipped before execution, fed back as a failed tool call). The rejection message names the target and the blocked path. Path comparison is normalized and rescues dot-flattened typos, so a mistyped target path still counts as on-target. No confident target or an all-green baseline → no enforcement. Set `=0` to fall back to the prompt-level guard only.
- `SC_SUITE` / `SC_N` / `SC_TASKS`: knobs for `scripts/probe-selfconsistency.ts` (the oracle-free self-consistency probe) — the suite to draw from, number of independent attempts per task, and comma-separated task-id substrings. Measurement-only; not used by the product runtime.
- `SWEBENCH_LIMIT`: how many SWE-bench-Lite instances `scripts/vendor-swebench.ts` ingests (and `scripts/run-swebench.ts` attempts). SWE-bench is **ingested** into runnable task descriptors here; **execution** needs a prepared per-instance Python env (the official Docker harness) — the runner clones + applies the test patch, then skips any instance whose deps aren't importable on this machine rather than report a fake 0.
- `SWEBENCH_WORK`: working dir where `scripts/run-swebench.ts` clones/caches SWE-bench repos at their `base_commit` (default `/tmp/swebench-work`).
- `SMALLCODE_R2_FORCE_LINE`: R2 upper-bound **probe** only (format `relpath:line`, e.g. `src/index.js:90`). When a turn fails with a value-mismatch diagnostic that has no natural throw-location, forces the R2 `## BUG LOCATION` window onto that line. Measurement knob (it uses knowledge the harness can't itself derive for an assertion mismatch) — never a shipped default. Used to measure whether handing a small model the exact buggy line lifts a floor: on the `mri` floor task an n=5 read gave 7b 1/5 with the line handed, but an n=8 re-run scored **0/8** (≈1/13, within noise of zero) — the 1/5 was underpowered. Neither 32b+line (0/5) nor a minimal-edit constraint (0/8) moved it; mri stays a genuine model-comprehension floor (both models over-rewrite the one-operator fix and break a short-circuit idiom).
- `SMALLCODE_MUTATION_REPAIR`: harness-side last-resort repair, **on by default** (set `=0` to disable). Fires only when the model loop ends a fix-mode run (red baseline) UNSOLVED with a locked target file — never on a run that already succeeded. It brute-forces every single operator flip in the target file (`enumerateComparisonMutations` in `src/repair/operator-mutation.ts`: comparison `===`↔`!==`, `==`↔`!=`, `<`↔`<=`, `<`↔`>=`, plus logical `&&`↔`||` and arithmetic `+`↔`-`, priority-ordered comparison-first then logical then arithmetic, capped by `SMALLCODE_MUTATION_REPAIR_MAX`), running the real tiered oracle on each candidate and keeping the FIRST that goes fully green (reverting every miss). Candidates are tried against the pristine pre-model version of the target file first, then the current on-disk version — a failing model often mangles the target on the way down (e.g. rewriting a `||` idiom into `&&`/ternary forms), so a flip may only reach green against the original. Deterministic and cannot fake-green — it requires a full-green oracle verdict. Motivated by the `mri` wrong-operator wall directly above: no model-side lever (exact-line localization, 32b escalation, minimal-edit prompting) fixed a single-comparison-operator bug, but the operator space is tiny and the oracle is deterministic, so the harness brute-forces it instead of asking the model to. A solve via this path is recorded as a synthetic turn tagged `mutationRepair: { label, line, attempts }` so it's attributable to the harness, not the model. A/B (7b, no probe): lifted the `mri` floor from **0.00 → 0.88** (CI-significant), the realrepo suite from 0.90 to ~0.95, and edit-reliability 0.99 → 1.00, with zero regression — hence default-on.
- `SMALLCODE_MUTATION_REPAIR_MAX`: caps the number of operator-flip candidates `runOperatorMutationRepair` (in `src/agent/loop.ts`) will try per pass (default `60`).
- `SMALLCODE_RAD_HINT`: **model-side** read-after-delete hint, **on by default** since v1.7.1 (set `=0` to disable). When a failing turn leaves the `X.delete(K); X.set(K, X.get(K))` pattern (which re-inserts `undefined`) in the model's attempt, the next prompt gets a `## STATEMENT ORDER BUG` section (via `detectReadAfterDelete` in `src/repair/read-after-delete.ts`) telling the model to read the value into a variable BEFORE the delete — the MODEL then reorders and solves, no harness rescue. A/B (`realrepo-lru-recency_1`, 7b, n=8): pass@1 **0.13 → 1.00**, avg turns 5.0 → 2.3, lucky-pass audit modelSolveRate 1.0 / 0 rescued — the first model-side lever to move a genuine realrepo floor. Default-on validated by a full 22-task realrepo A/B (7b, n=8): the detector fired on the `lru-recency` pattern only (zero fires across the other 21 tasks / 176 trials), so it is inert everywhere else; the two other-task swings in that A/B (`toposort-cycle`, `csv-quote`) were confirmed sampling noise by a lever-off control rerun.
- `SMALLCODE_STATEMENT_REPAIR`: **harness-side** deterministic last-resort for the read-after-delete ordering bug, **off by default** (set `=1` to enable). Gated exactly like `SMALLCODE_MUTATION_REPAIR` (fires only on an UNSOLVED fix-mode run with a locked target); recovers the model's (possibly reverted) attempt via the new `latestAttemptContent` loop helper, deterministically hoists the read into a `__radVal` temp before the delete (`repairReadAfterDelete`), runs the real oracle, and keeps the first full-green candidate — logged `[statement-repair] SOLVED …` and recorded as a `mutationRepair` turn so the lucky-pass audit attributes it `rescued`. Disjoint bug-shape from operator-mutation repair (no operator flip fixes an ordering mistake). A/B (`realrepo-lru-recency_1`, 7b, n=8): pass@1 **0.13 → 1.00**, audit rescuedRate 1.0 / 0 model.
- `SMALLCODE_FINAL_STATE_GUARD`: **harness-side** final-state regression guard — the "never leave the repo worse than you found it" guarantee, **off by default** (set `=1` to enable, pending dogfood validation then promotion). Runs absolutely last, only when the run ended UNSOLVED after the model loop and every repair pass. It recaptures the full `bun test` baseline on the FINAL disk state (`captureTestBaseline`) and compares to the run-START baseline via `finalStateWorseThanBaseline` (in `src/verify/oracle.ts`): if the repo is strictly WORSE (higher red count OR a test failing now that was green/absent at baseline), it restores every file the agent touched to its pristine pre-model content (`pristineRunSnapshot` + `revertFiles`) and deletes any brand-new files it created, then re-verifies the restore reached ≤ baseline — logged `[final-state-guard] reverted N file(s) …` and recorded on `state.finalStateReverted`. **Eval-neutral by construction**: it only fires on unsolved runs and reverts to the seeded-bug start state, so an unsolved trial stays unsolved (pass/fail unchanged) — it removes broken residue that the per-turn revert can't (per-turn revert can't undo a brand-new file, and is a safety net for any late/cross-file regression it misses). Closes the dogfood Gap 2 (a wandering/partial run could exit with more red than it started).
- `SMALLCODE_IMPORT_GATE`: **harness-side** static import-resolution gate, **off by default** (set `=1` to enable, pending validation then promotion). Kills HALLUCINATED imports (the dogfood `std/strings` failure) before they cost a turn. After a `FILE:`/`PATCH:` edit lands on an existing source file, it extracts the import specifiers the edit INTRODUCED (`extractImportSpecifiers` in `src/verify/import-check.ts`) and resolves each against ground truth — relative paths via `Bun.resolveSync` from the file's dir, bare packages against **this repo's** `package.json` deps + repo-local `node_modules` (deliberately NOT Bun's global install cache — an undeclared-but-machine-cached package must still be flagged; a live-fire caught exactly that false-negative on `slugify`), builtins always OK. Any specifier that does NOT resolve reverts that file to its pre-edit content and feeds the model a targeted `IMPORT ERROR — 'std/strings' does not resolve … this repo's dependencies are: …` message that names the deps that DO exist (`formatImportRejection`) — a crisper, earlier, more actionable signal than the reactive-only R4 path (which surfaces `Cannot find module` only after a full test run, and only when a test imports the edited file, so the model looped re-emitting the same invented module). Conservative (a declared dep or a repo-local relative/package resolution passes) to keep false-rejects near zero; only NEW imports are checked, and test/brand-new files are skipped. Proactive fix for the dogfood Gap 4 (hallucinated APIs).
<!-- agent-skills:doc-keeper:end -->

## Escalation — scale to your hardware

smallcode's default is a single small local model (e.g. `qwen2.5-coder:3b`) — runs on modest hardware, fully offline. With more hardware you can let a run **escalate** to bigger local models only when the small one can't crack a task, paying for the big model just on the residual.

It rides the Best-of-N seam: each attempt is independent and the run stops on the first oracle-green result, so a ladder spends the small model first and climbs only on failure.

```jsonc
// smallcode.config.json — escalation/bestOfN/activeModel live under the "config" key
{
  "config": {
    "provider": { "baseUrl": "http://localhost:11434/v1", "apiKey": "none", "timeoutMs": 120000 },
    "activeModel": "qwen2.5-coder:3b",
    "bestOfN": 3,
    "escalation": ["qwen2.5-coder:3b", "qwen2.5-coder:7b", "gemma4:12b"]
  }
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
