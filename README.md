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

Writes `smallcode.config.json` pointed at `http://localhost:11434/v1`, with `sandbox.requireApproval: true` (each edit is shown for a `y/N` in an interactive terminal — nothing lands without your OK) and the default escalation ladder `["qwen2.5-coder:3b", "qwen2.5-coder:7b"]` (climbs to 7b only if 3b's fix doesn't pass the test oracle). Without `--model`, `config init` defaults to the recommended **`qwen2.5-coder:3b`** (fast, code-tuned); pass `--model vibethinker-3b` for the origin reasoner. `config init` validates the model id against the registry and rejects a typo up front (listing the valid ids), so a bad id never lands in your config to fail later at inference.

**2. Verify your setup**

```bash
smallcode doctor
```

Checks the whole setup in one shot — Bun, the Ollama CLI, the Ollama **server** (reachable?), your config (valid? model id known?), whether the active model is **pulled**, and git/test-runner — and prints a copy-pasteable fix for anything broken (e.g. `ollama serve`, `ollama pull qwen2.5-coder:3b`). Exits non-zero if anything blocking is wrong, so it drops cleanly into CI/scripts (`--json` for a machine-readable report). Run it first whenever a run misbehaves.

**3. Point it at a repo with a failing test and let it fix that test**

```bash
smallcode fix --repo /path/to/repo
```

Runs your test command (default `bun test`); if it's already green, this is a no-op. If it's RED, smallcode derives a fix task from the failing output and drives the agent loop, stopping the moment the test oracle goes green — escalating 3b → 7b automatically if the small model can't solve it.

Or describe a task in your own words:

```bash
smallcode run "add input validation to src/api/handler.ts" --repo /path/to/repo
```

Success means the change was **oracle-verified**: the test suite (or, for untested code, a static-confidence grade) confirmed the fix, not just that the model claimed to be done.

**4. Review, and undo if needed**

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

**Troubleshooting — "Ollama not reachable":** `run`, `fix`, and `chat` preflight the server before the first model call, so if Ollama is down or the endpoint is wrong you get an immediate, actionable message (`Ollama not reachable at <url> — start it with 'ollama serve'`) with a non-zero exit, instead of a cryptic inference timeout. Run `smallcode doctor` for a full setup diagnosis.

**Long sessions (recommended):** For sessions longer than ~1 hour, launch Ollama via the provided script instead of `ollama serve`. It sets `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`, which halve KV-cache VRAM usage and slow the llama.cpp KV-cache fragmentation that causes throughput decay on Apple Silicon:

```bash
chmod +x scripts/ollama-serve.sh
scripts/ollama-serve.sh   # drop-in replacement for `ollama serve`
```

The throughput watchdog (`SMALLCODE_WATCHDOG`, on by default) also detects decay automatically and unloads/reloads the model mid-session, but starting with the optimised flags defers the first decay event considerably. Its wall-clock tok/s metric is only reliable while the prompt stays under `SMALLCODE_WATCHDOG_MAX_PROMPT` tokens (default 8192) — above that, Ollama's prompt-eval (prefill) time dominates wall-clock and the watchdog abstains from judging throughput rather than false-triggering a reload (avoids a reload/re-prefill thrash-loop at large `num_ctx`).

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
| `run` | `<task description>` (positional) `--repo <path>` `--config <path>` `--model <id>` `--max-turns <n>` `--best-of-n <n>` `--escalation <m1,m2,..>` `--json` `--yes` | Run the agent on a coding task inside the given repo directory, e.g. `smallcode run "add input validation to src/api/handler.ts" --repo .`. Ends with a diff summary + how to review/undo. `--json` prints exactly one JSON line (`{ok, verified, status, model, turnsUsed, filesChanged, added, removed, reason, mechanism, mechanismDetail, guardFired, restoreVerified, filesRestored, failingTests}`) to stdout instead — for scripting/CI, exit code is unchanged (0 iff verified). Every run also ends with an honest one-liner: a solve says HOW (`Solved by the model.` / `…by a harness rescue…` / `…after escalating to <model>.`); a failure says WHY + the tree state (`Could not fix — ran out of turns…; the guard restored N file(s) (restore verified); Still failing: …`) so a run is never a silent, confidently-wrong diff. |
| `fix` | `--repo <path>` `--test "<cmd>"` `--model <id>` `--best-of-n <n>` `--escalation <m1,m2,..>` `--max-turns <n>` `--json` | Test-driven auto-fix: runs the test command (default `bun test`); if GREEN, exits 0 immediately ("nothing to fix"); if RED, derives a task from the failing output and runs the SAME pipeline as `run`. The pre-commit / delegation primitive — point a hook or another agent at it and it either no-ops or drives the loop until tests pass (or gives up honestly). |
| `chat` | `--repo <path>` `--model <id>` `--config <path>` | Interactive multi-task session — keeps the repo index + model warm across tasks. Slash-commands: `/add` `/drop` `/files` (pin context), `/diff` `/undo` (review/revert), `/model` `/clear` `/help` `/exit`. Any other line is a coding task. |
| `doctor` | `--endpoint <url>` `--repo <path>` `--config <path>` `--json` | Diagnose the whole local setup in one command — Bun, Ollama CLI, Ollama **server** reachable, config valid + model id known, active model **pulled**, git repo + test runner. Prints ✓/✗ per check with a copy-pasteable fix (`ollama serve`, `ollama pull <id>`, `smallcode config init`). Exits non-zero if any blocking (P0) check fails; `--json` for a machine-readable report. Run it first when a run misbehaves. |
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
| `qwen2.5-coder:3b` | 32,768 tokens | 0.7 | — | **Recommended.** Apache-2.0. No think-only spiral. 30-60x faster than VibeThinker. realrepo pass@1: **0.78 [.73–.84]** default harness / 0.74 [.68–.80] model-only (22 tasks, n=10, pooled n=220). Aces klona tasks where VibeThinker scored 0/10. |
| `qwen2.5-coder:7b` | 32,768 tokens | 0.7 | — | **Recommended (larger).** Apache-2.0. realrepo pass@1: **0.94 [.91–.97]** default harness / 0.90 [.85–.93] model-only (22 tasks, n=10, pooled n=220). Bigger model arm of the 3-way comparison. |
| `qwen2.5-coder-14b` | 131,072 tokens | 0.7 | — | Highest quality of built-in profiles. Supports JSON schema and grammar-constrained output. |
| `vibethinker-3b` | 65,536 tokens | 1.0 | `<think>` / `</think>` | Origin baseline. MIT license. Produced the 0.828 HumanEval-TS result. Think-only spiral on some real-lib bugs (0/10 klona). Still supported via `SMALLCODE_MODEL=vibethinker-3b`. |

Swap the active model per-run without editing config via `SMALLCODE_MODEL` (e.g. `SMALLCODE_MODEL=qwen2.5-coder:3b`). Custom models can be registered in the `models` array of your config file using the `ModelProfile` schema.

### Why qwen?

We built smallcode on VibeThinker-3B — it produced the 0.828 HumanEval-TS baseline and revealed a "think-only" reasoning spiral: the model burns its generation budget inside `<think>`, emits no code, scoring 0/10 on some real-lib bugs. We confirmed the HARNESS, not the model, does the work by swapping to qwen2.5-coder:3b — same 3B size, no think-only, 30-60x faster — and rerunning the realrepo suite: qwen-3b 0.52, qwen-7b 0.73 on the original suite; the current 22-task suite (n=10, pooled n=220) puts qwen-3b at **0.78 [.73–.84]** default harness / 0.74 [.68–.80] model-only and qwen-7b at **0.94 [.91–.97]** default harness / 0.90 [.85–.93] model-only. VibeThinker-3B remains the origin story and is still fully supported.

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
- `SMALLCODE_TARGET_SET`: multi-file target set, **ON by default since 2026-07-09**. Generalizes `SMALLCODE_TARGET_LOCK`'s single-file lock into a BOUNDED editable set — the pinned primary target plus the source files it directly imports (one hop, resolvable, repo-local, non-test; capped at `maxNeighbors=4` for wander-safety — `src/agent/target-set.ts`'s `computeEditableSet`). Lets a fix that genuinely spans a function and its helper module edit both files, while edits OUTSIDE the neighborhood still hard-reject on both write paths (`applyBatch(..., { targetPaths })` and `TOOL: write_file`, via `isInEditableSet`); the "## STAY ON TARGET" prompt widens "Edit ONLY `<target>`" to name the whole set. A/B on `multifile-receipt_1` (a genuine two-file bug) is causal: qwen2.5-coder 7b canNOT use it (0/5 regardless of the flag — never localizes the 2nd-file bug); qwen2.5-coder 32b + set ON solves in 1 turn editing both files, 32b + set OFF fails (single lock corrals it onto the primary). Same model, only the flag differs. A 22-task realrepo regression A/B (2026-07-09) then validated the flip to default ON is pass@1-neutral on single-file tasks (pooled 0.892 ON = 0.892 OFF, identical CIs [.838-.930], 20/22 tasks byte-identical), so it now unlocks multi-file fixes by default. Set `=0` to disable. **Caveats:** a generality follow-up across 3 more two-file coupling shapes confirmed TARGET_SET (editability alone) is the robust general win — it carried a new shape to 0.90 pass@1 with no other lever's help — but see `SMALLCODE_SET_CAROUSEL` below and `SMALLCODE_LITERAL_REPAIR` for what does NOT generalize.
- `SMALLCODE_SET_CAROUSEL`: set-carousel, **ON by default since 2026-07-09** (requires `SMALLCODE_TARGET_SET` on). The 7b above still can't USE the target set — it fixates on the primary file, never reaching the coupled bug in a neighbor. The carousel makes the HARNESS decompose the cross-file localization instead of the model: when the model stalls on its current focus file (`stallCount` reaches `STALL_LIMIT`) while the oracle still fails, it deterministically advances ATTENTION to the next file in `editablePaths`, with a fresh "## FOCUS THIS TURN" prompt hint and a fresh stall+redraft budget for the new focus — turning one hard multi-file localization into a sequence of single-file ones. Fires on stall alone (not gated on exhausting redrafts first — in set-mode the carousel takes priority over same-file redraft, since redrafting the same file is useless when the bug is elsewhere) so it triggers well within a bounded eval's turn budget. Attention-only — never touches `lockedTargetPath`, `editablePaths`, enforcement, the oracle, or revert; every set member stays editable throughout exactly as `SMALLCODE_TARGET_SET` already allows. Capped at two full sweeps of the set. `src/agent/carousel.ts`. On single-file tasks the set is length 1 so this is a no-op; the same 22-task regression A/B confirmed pooled pass@1 unchanged (0.892 = 0.892). Set `=0` to disable. **Caveat — the "16% → 96%" ladder does not generalize:** on `multifile-receipt_1`, stacking TARGET_SET + carousel + `SMALLCODE_LITERAL_REPAIR` took a 7b from 0.16 (bare) → 0.48 (+ carousel) → 0.96 (+ literal-repair), every step CI-significant — but that fixture's neighbor bug happened to be a brute-forceable integer-literal constant (`toFixed(1)`→`(2)`). A follow-up generality test across 3 more genuine two-file coupling shapes (none literal/operator-crackable) found carousel is a CONDITIONAL stall-rescue, not a universal lift: no-op when TARGET_SET alone already solves it (0.90 = 0.90), a non-significant nudge on a shape the model fixates on (0.00 → 0.10), and useless against a genuine capability ceiling (0.00 = 0.00). Don't cite 16→96 as a general result — it's specific to the receipt fixture's literal-crackable coupling.
- `SC_SUITE` / `SC_N` / `SC_TASKS`: knobs for `scripts/probe-selfconsistency.ts` (the oracle-free self-consistency probe) — the suite to draw from, number of independent attempts per task, and comma-separated task-id substrings. Measurement-only; not used by the product runtime.
- `SWEBENCH_LIMIT`: how many SWE-bench-Lite instances `scripts/vendor-swebench.ts` ingests (and `scripts/run-swebench.ts` attempts). SWE-bench is **ingested** into runnable task descriptors here; **execution** needs a prepared per-instance Python env (the official Docker harness) — the runner clones + applies the test patch, then skips any instance whose deps aren't importable on this machine rather than report a fake 0.
- `SWEBENCH_WORK`: working dir where `scripts/run-swebench.ts` clones/caches SWE-bench repos at their `base_commit` (default `/tmp/swebench-work`).
- `SMALLCODE_R2_FORCE_LINE`: R2 upper-bound **probe** only (format `relpath:line`, e.g. `src/index.js:90`). When a turn fails with a value-mismatch diagnostic that has no natural throw-location, forces the R2 `## BUG LOCATION` window onto that line. Measurement knob (it uses knowledge the harness can't itself derive for an assertion mismatch) — never a shipped default. Used to measure whether handing a small model the exact buggy line lifts a floor: on the `mri` floor task an n=5 read gave 7b 1/5 with the line handed, but an n=8 re-run scored **0/8** (≈1/13, within noise of zero) — the 1/5 was underpowered. Neither 32b+line (0/5) nor a minimal-edit constraint (0/8) moved it; mri stays a genuine model-comprehension floor (both models over-rewrite the one-operator fix and break a short-circuit idiom).
- `SMALLCODE_MUTATION_REPAIR`: harness-side last-resort repair, **on by default** (set `=0` to disable). Fires only when the model loop ends a fix-mode run (red baseline) UNSOLVED with a locked target file — never on a run that already succeeded. It brute-forces every single operator flip in the target file (`enumerateComparisonMutations` in `src/repair/operator-mutation.ts`: comparison `===`↔`!==`, `==`↔`!=`, `<`↔`<=`, `<`↔`>=`, plus logical `&&`↔`||` and arithmetic `+`↔`-`, priority-ordered comparison-first then logical then arithmetic, capped by `SMALLCODE_MUTATION_REPAIR_MAX`), running the real tiered oracle on each candidate and keeping the FIRST that goes fully green (reverting every miss). Candidates are then SCOPED to the locked target function's line range (`scopeMutationsToRange`, keyed to `state.lockedTargetRange`, captured from `context.targetFile.functionStartLine`/`functionEndLine`) so a flip in an unrelated part of the file can never be kept as a coincidental "green" fix — falls back to whole-file when the function range is unknown. It is additionally GATED to genuine assertion/logic reds: when the baseline failure is a compile/load error — a missing export/module, syntax error, or unresolved import (`hasLoadError`, e.g. `Export named 'x' not found`), which no operator flip can ever satisfy — the pass is skipped (logged `[repair] skipped …`) instead of churning the full oracle over every candidate. (Dogfood 2026-07-07: an add-a-function run whose red was a missing export previously burned ~36 suite runs across two rungs for nothing.) Candidates are tried against the pristine pre-model version of the target file first, then the current on-disk version — a failing model often mangles the target on the way down (e.g. rewriting a `||` idiom into `&&`/ternary forms), so a flip may only reach green against the original. It requires a full-green oracle verdict. A 2026-07-15 model-free audit (`scripts/audit-operator-mutation.ts`) initially appeared to show fake-greens, but manual verification of the reference diffs found **0 genuine fake-greens** — every greening flip either matched the reference fix exactly (e.g. the mri `!==→===` fix) or was a semantically-equivalent boundary alternative (`>=` vs `>` for max-finding, where ties don't change the result) that legitimately passes the full oracle. (The audit's first automated classifier had a false-positive bug, since fixed, that mislabeled these true fixes as fake.) It stays default ON. Motivated by the `mri` wrong-operator wall directly above: no model-side lever (exact-line localization, 32b escalation, minimal-edit prompting) fixed a single-comparison-operator bug, but the operator space is tiny and the oracle is deterministic, so the harness brute-forces it instead of asking the model to. A solve via this path is recorded as a synthetic turn tagged `mutationRepair: { label, line, attempts }` so it's attributable to the harness, not the model. A/B (7b, no probe): lifted the `mri` floor from **0.00 → 0.88** (CI-significant), the realrepo suite from 0.90 [.85–.93] to 0.94 [.91–.97] (22-task, 7b, n=10, pooled n=220), and edit-reliability 0.99 → 1.00, with zero regression — hence default-on.
- `SMALLCODE_MUTATION_REPAIR_MAX`: caps the number of operator-flip candidates `runOperatorMutationRepair` (in `src/agent/loop.ts`) will try per pass (default `60`).
- `SMALLCODE_RAD_HINT`: **model-side** read-after-delete hint, **on by default** since v1.7.1 (set `=0` to disable). When a failing turn leaves the `X.delete(K); X.set(K, X.get(K))` pattern (which re-inserts `undefined`) in the model's attempt, the next prompt gets a `## STATEMENT ORDER BUG` section (via `detectReadAfterDelete` in `src/repair/read-after-delete.ts`) telling the model to read the value into a variable BEFORE the delete — the MODEL then reorders and solves, no harness rescue. A/B (`realrepo-lru-recency_1`, 7b, n=8): pass@1 **0.13 → 1.00**, avg turns 5.0 → 2.3, lucky-pass audit modelSolveRate 1.0 / 0 rescued — the first model-side lever to move a genuine realrepo floor. Default-on validated by a full 22-task realrepo A/B (7b, n=8): the detector fired on the `lru-recency` pattern only (zero fires across the other 21 tasks / 176 trials), so it is inert everywhere else; the two other-task swings in that A/B (`toposort-cycle`, `csv-quote`) were confirmed sampling noise by a lever-off control rerun.
- `SMALLCODE_STATEMENT_REPAIR`: **harness-side** deterministic last-resort for the read-after-delete ordering bug, **off by default** (set `=1` to enable). Gated exactly like `SMALLCODE_MUTATION_REPAIR` (fires only on an UNSOLVED fix-mode run with a locked target); recovers the model's (possibly reverted) attempt via the new `latestAttemptContent` loop helper, deterministically hoists the read into a `__radVal` temp before the delete (`repairReadAfterDelete`), runs the real oracle, and keeps the first full-green candidate — logged `[statement-repair] SOLVED …` and recorded as a `mutationRepair` turn so the lucky-pass audit attributes it `rescued`. Disjoint bug-shape from operator-mutation repair (no operator flip fixes an ordering mistake). A/B (`realrepo-lru-recency_1`, 7b, n=8): pass@1 **0.13 → 1.00**, audit rescuedRate 1.0 / 0 model.
- `SMALLCODE_LITERAL_REPAIR`: **harness-side** deterministic last-resort for a wrong integer CONSTANT (e.g. `toFixed(1)` should be `toFixed(2)`), **off by default** (set `=1` to enable). Disjoint bug-shape from operator-mutation repair — there is no operator to flip when the bug IS the number. Gated like `SMALLCODE_MUTATION_REPAIR` (post-loop, unsolved fix-mode run, locked target, non-load-error baseline). The pure enumerator `enumerateLiteralMutations` (`src/repair/literal-mutation.ts`) scans for standalone integer literals and generates ±1/±2 perturbation candidates (priority-ordered, reusing `scopeMutationsToRange` from `operator-mutation.ts`); the I/O half `runLiteralRepair` (`src/agent/loop.ts`) runs the real oracle on each and keeps the first full-green, reverting non-winners. **Key deviation**: unlike operator-mutation/statement-repair, it iterates the multi-file EDITABLE SET (`state.editablePaths`, populated by `SMALLCODE_TARGET_SET`) rather than the single locked target — scoped to the target function's line range on the primary file, whole-file on neighbor files, with one TOTAL candidate cap (`SMALLCODE_LITERAL_REPAIR_MAX`) shared across the whole set. Complements the set-carousel: the carousel narrows WHICH file has the bug, literal-repair fixes the CONSTANT in it. Records a `mutationRepair` turn so the lucky-pass audit attributes a solve as harness-rescued. **Kept OFF pending a stronger guard**: a 2026-07-13 model-free audit (`scripts/audit-literal-repair.ts`) found it CAN fake-green — 4/38 solution-backed tasks go green via a semantically-wrong `1`→`0` flip that imitates a `- 1`/`+ 1` term-removal (or a boundary-operator) reference fix on a thin oracle; fn-range scoping does not close the gap (the flips sit inside the target function).
- `SMALLCODE_LITERAL_REPAIR_MAX`: caps the number of literal-mutation candidates `runLiteralRepair` will try per pass, TOTAL across every file in the editable set (default `60`).
- `SMALLCODE_FINAL_STATE_GUARD`: **harness-side** final-state regression guard — the "never leave the repo worse than you found it" guarantee, **default ON since 2026-07-05** (set `=0` to disable; promoted after validation: eval-neutral, realrepo subset pooled pass@1 0.90 = baseline). Runs absolutely last, only when the run ended UNSOLVED after the model loop and every repair pass. It recaptures the full `bun test` baseline on the FINAL disk state (`captureTestBaseline`) and compares to the run-START baseline via `finalStateWorseThanBaseline` (in `src/verify/oracle.ts`): if the repo is strictly WORSE (higher red count OR a test failing now that was green/absent at baseline), it restores every file the agent touched to its pristine pre-model content (`pristineRunSnapshot` + `revertFiles`) and deletes any brand-new files it created, then re-verifies the restore reached ≤ baseline — logged `[final-state-guard] reverted N file(s) …` and recorded on `state.finalStateReverted`. **Verified restore (E1-T3)**: `revertFiles` reads each restored file back and byte-compares it to the captured original, and the guard confirms every created file is actually deleted; the result is recorded as `finalStateReverted.restoreVerified`. On any mismatch it is **fail-closed** — a loud `[final-state-guard] UNSAFE …` line names the inconsistent path and points to recovery (`git checkout -- .` / the write-ahead journal) instead of reporting a safety it cannot prove. The per-turn revert carries the same read-back check. **Eval-neutral by construction**: it only fires on unsolved runs and reverts to the seeded-bug start state, so an unsolved trial stays unsolved (pass/fail unchanged) — it removes broken residue that the per-turn revert can't (per-turn revert can't undo a brand-new file, and is a safety net for any late/cross-file regression it misses). Closes the dogfood Gap 2 (a wandering/partial run could exit with more red than it started). **Throw containment (dogfood #3, 2026-07-08)**: the guard only helps if the loop reaches it — `runOperatorMutationRepair` and `runStatementRepair` (both exported from `src/agent/loop.ts`/`src/agent/index.ts`, alongside `runFinalStateGuard`) call the real oracle per candidate, which can throw (e.g. a `bun test` timeout on a large repo); an unguarded throw previously escaped `runLoop`, leaving a half-tried candidate on disk and skipping the guard entirely. Both repair fns now restore the model's pre-repair edit and return `null` on any throw instead of propagating, and `runLoop` wraps both repair-pass blocks in an outer try/catch as defense-in-depth, so this guard is unconditionally reached.
- `SMALLCODE_IMPORT_GATE`: **harness-side** static import-resolution gate, **default ON since 2026-07-05** (set `=0` to disable; promoted after live-fire validation: caught + reverted a real 3B hallucinated `import ... from "slugify"`, zero false-fires, with the global-cache resolver fix). Kills HALLUCINATED imports (the dogfood `std/strings` failure) before they cost a turn. After a `FILE:`/`PATCH:` edit lands on an existing source file, it extracts the import specifiers the edit INTRODUCED (`extractImportSpecifiers` in `src/verify/import-check.ts`) and resolves each against ground truth — relative paths via `Bun.resolveSync` from the file's dir, bare packages against **this repo's** `package.json` deps + repo-local `node_modules` (deliberately NOT Bun's global install cache — an undeclared-but-machine-cached package must still be flagged; a live-fire caught exactly that false-negative on `slugify`), builtins always OK. Any specifier that does NOT resolve reverts that file to its pre-edit content and feeds the model a targeted `IMPORT ERROR — 'std/strings' does not resolve … this repo's dependencies are: …` message that names the deps that DO exist (`formatImportRejection`) — a crisper, earlier, more actionable signal than the reactive-only R4 path (which surfaces `Cannot find module` only after a full test run, and only when a test imports the edited file, so the model looped re-emitting the same invented module). Conservative (a declared dep or a repo-local relative/package resolution passes) to keep false-rejects near zero; only NEW imports are checked, and test/brand-new files are skipped. Proactive fix for the dogfood Gap 4 (hallucinated APIs).
- `SMALLCODE_APPLY_JOURNAL`: **harness-side** write-ahead apply journal / crash recovery, **default ON** (set `=0` to disable). Every other safety guard runs *in the same process*, so a process kill / OOM / model-backend disconnect *mid-apply* (file 1 written, file 2 not) skips them all and leaves a half-written repo with no rollback. Before each on-disk edit — routed through both `applyBatch` and the `write_file` TOOL path — the harness records that file's PRE-RUN content (or a "did-not-exist" marker for files the run creates) to a journal OUTSIDE the repo (`os.tmpdir()/smallcode-journal/<hash(repoRoot)>.json`, per-repo keyed so eval trials never collide), first-seen-wins per path. On the NEXT invocation, `recoverIfNeeded` finds any surviving `in-progress` journal (a run that never reached its clean terminal state), REPLAYS it — restore each original, delete files the crashed run created (best-effort per entry) — returns the tree to its exact pre-run state, and logs `[smallcode] recovered an interrupted run — restored N file(s)…`. A clean run deletes its journal (`markClean`, right before `runLoop` returns, after the guard); a crash leaves it. Net effect: edit-apply is **atomic at run-granularity across a crash**. `src/agent/journal.ts`.
- `SMALLCODE_SEMANTIC_RETRIEVAL`: **retrieval-side** semantic fusion, **opt-in, default OFF** (set `=1` to enable). Adds a LOCAL-embedding cosine signal on top of the lexical file scorer so a task can localize a file it shares no WORD with — the lexical ceiling the defines-over-uses signal cannot cross (a task that says "cycle its focus across files" reaches `carousel.ts` even though no token overlaps). Embeds a compact per-file profile (path + symbol signatures) and the task query with a local Ollama embedding model via the same base URL, cosine-ranks, and fuses the above-threshold similarity as an ADDITIVE boost into the lexical score (`src/context/semantic.ts` → `buildContext`), so a strong semantic hit can resurrect a lexically-zero definer without dominating. The file index is embedded ONCE per run and reused across the planner + every turn. Fully offline; a down/absent embedder or any embedding failure degrades to lexical-only (never breaks a run). Measured by `scripts/localization-probe.ts`: on the blind independent probe it lifts top-1 localization 31%→50% and top-3 44%→69% over the lexical-only path (which itself was 13%→31% / 13%→44% from defines-over-uses), synthetic overlay accuracy unaffected (flag off there).
- `SMALLCODE_EMBED_MODEL`: local embedding model name for `SMALLCODE_SEMANTIC_RETRIEVAL` (default `nomic-embed-text`, a 274 MB Ollama model). Must be pulled locally (`ollama pull nomic-embed-text`).
- `SMALLCODE_SEMANTIC_WEIGHT`: max additive boost a perfect (cosine 1) semantic match adds to a file's lexical score (default `100`). Tuned on the blind localization probe — the plateau start; above ~140 semantic begins overpowering good lexical picks and localization regresses.
- `SMALLCODE_SEMANTIC_THRESHOLD`: cosine floor below which a file's semantic similarity contributes nothing (default `0.55`, must be in `(0,1)`). Thresholding keeps a diffuse "everything is a little similar" haze from lifting every file above zero (which would defeat the lexical `score>0` target gate).
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
