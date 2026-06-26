# smallcode

> Agentic coding for small, local models. Designed for WeiboAI/VibeThinker-3B and any OpenAI-compatible endpoint.

smallcode wraps 3B–14B class models in scaffolding that compensates for their weaknesses — format fragility, weak long context, high output variance — and amplifies their strengths: verifiable reasoning on self-contained tasks. Unlike Aider, Claude Code, and Goose, which assume a frontier model that can hold arbitrary context and reason reliably, smallcode inverts the approach: minimize context, externalize state, constrain output format, decompose tasks, verify deterministically, and sample best-of-N.

[Full architecture diagram →](docs/architecture.html)

---

## Quickstart

### Prerequisites

- **[Bun](https://bun.sh)** (JavaScript runtime + package manager) — `curl -fsSL https://bun.sh/install | bash`
- **[Ollama](https://ollama.com/download)** (local model server) — then pull the model:
  ```bash
  ollama pull weiboai/vibethinker-3b
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
smallcode --version   # prints: smallcode v0.1.0
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

**1. Install Ollama and pull VibeThinker-3B**

```bash
# Install Ollama: https://ollama.com/download
ollama pull weiboai/vibethinker-3b
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
    "activeModel": "vibethinker-3b",
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

## Serving VibeThinker-3B

### Ollama (recommended)

```bash
# Pull the model
ollama pull weiboai/vibethinker-3b

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
# Build llama.cpp, then:
./llama-server \
  --model models/VibeThinker-3B-Q4_K_M.gguf \
  --port 8080 \
  --ctx-size 65536
```

Set `provider.baseUrl` to `http://localhost:8080/v1`.

### LM Studio

1. Download and open LM Studio.
2. Search for `WeiboAI/VibeThinker-3B` and download the GGUF.
3. Start the local server (default port: 1234).
4. Set `provider.baseUrl` to `http://localhost:1234/v1`.

### vLLM / SGLang

```bash
# vLLM
vllm serve WeiboAI/VibeThinker-3B \
  --port 8000 \
  --max-model-len 65536

# SGLang
python -m sglang.launch_server \
  --model-path WeiboAI/VibeThinker-3B \
  --port 30000
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
    "activeModel": "vibethinker-3b",
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
| `config.sandbox.requireApproval` | boolean | `true` | Gate destructive file writes behind an approval prompt. |
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
| `run` | `--task <string>` `--repo <path>` `--config <path>` `--model <id>` `--max-turns <n>` `--best-of-n <n>` | Run the agent on a coding task inside the given repo directory. |
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
| `vibethinker-3b` | 65,536 tokens | 1.0 | `<think>` / `</think>` | Reference model. MIT license. Strong at verifiable code/math, high variance — use `bestOfN ≥ 3` for important tasks. |
| `qwen2.5-coder-7b` | 131,072 tokens | 0.7 | — | Supports JSON schema and grammar-constrained output. Lower variance than VibeThinker-3B. |
| `qwen2.5-coder-14b` | 131,072 tokens | 0.7 | — | Highest quality of built-in profiles. Supports JSON schema and grammar-constrained output. |

Custom models can be registered in the `models` array of your config file using the `ModelProfile` schema.

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
- `SMALLCODE_DIFF_EDIT`: `1` switches big-file PATCH editing from "re-emit the complete function" to a minimal SEARCH/REPLACE diff (changes only the buggy lines). Size-gated — applies only to target functions ≥ `SMALLCODE_DIFF_MIN_FN` lines, where whole-function re-emission causes over-editing. Default off.
- `SMALLCODE_DIFF_MIN_FN`: minimum target-function line span for `SMALLCODE_DIFF_EDIT` to use a diff (default `30`). Below it, whole-function PATCH is kept (small functions don't benefit and exact-match diffs add fragility).
- `SMALLCODE_MODEL`: override the active model id for a run (e.g. `qwen2.5-coder:3b`, `qwen2.5-coder:7b`, `vibethinker-3b`) — a cross-model A/B with no config edit.
<!-- agent-skills:doc-keeper:end -->
