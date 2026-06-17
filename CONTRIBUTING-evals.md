# Contributing Eval Tasks

This document explains how to add, verify, and maintain evaluation tasks for the smallcode eval suite.

---

## 1. Task Schema

Each task is a JSON file in `evals/suites/<suite-name>/<task-id>.json`.

```json
{
  "id": "cap-add-two-nums_1",
  "desc": "Implement a function that adds two numbers and returns the result.",
  "setup": {
    "repoFixture": "cap-add-two-nums_1",
    "files": {}
  },
  "graders": [
    {
      "type": "deterministic_tests",
      "required": ["tests/math.test.ts"],
      "command": "bun test"
    }
  ],
  "trackedMetrics": ["n_turns", "n_toolcalls", "n_total_tokens", "pass_at_1"],
  "referenceSolution": "cap-add-two-nums_1",
  "tags": ["capability", "typescript"]
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique task identifier. Convention: `<suite-prefix>-<short-desc>_<version>`. Must match the filename. |
| `desc` | yes | Task description shown to the agent. Must be unambiguous — see [Two-engineer agreement bar](#3-two-engineer-agreement-bar). |
| `setup.repoFixture` | yes (unless `files` used) | Path relative to `evals/fixtures/` of the directory to copy as the working repo. |
| `setup.files` | no | Inline file contents to write into the working directory (alternative to a fixture). |
| `graders` | yes | One or more grader configurations (see below). |
| `graders[].type` | yes | One of `deterministic_tests`, `static_analysis`, `llm_rubric`. |
| `graders[].required` | yes (deterministic_tests) | List of test file paths that must all pass. |
| `graders[].command` | no | Test command to run. Default: `bun test`. |
| `graders[].commands` | yes (static_analysis) | List of commands to run (e.g. `["biome check .", "tsc --noEmit"]`). |
| `graders[].rubric` | yes (llm_rubric) | Path to a rubric markdown file or inline rubric text. |
| `graders[].dimensions` | no (llm_rubric) | One judge per dimension for isolation. |
| `trackedMetrics` | yes | Metrics to record per trial. Always include `pass_at_1`. |
| `referenceSolution` | yes | Path relative to `evals/fixtures/` of the known-good state. See [Reference solution requirement](#2-reference-solution-requirement). |
| `tags` | no | Free-form tags for filtering. Common: `capability`, `regression`, `typescript`, `should-not-edit`. |

---

## 2. Reference Solution Requirement

Every task **must** have a `referenceSolution` — a fixture directory containing code that passes all graders.

### Why it exists

The reference solution serves three purposes:

1. **Grader sanity check** — `SMALLCODE_DRY_RUN=1 bun scripts/run-baseline.ts` runs every reference solution through its graders. If a reference solution fails, the task is broken before the model ever runs. This is the CI gate.
2. **Grader_bug detection** — `bun scripts/triage-transcripts.ts` can compare a failed trial against the reference solution to detect cases where the grader rejects a valid answer.
3. **Regression anchor** — if the model's solution is structurally identical to the reference, it should always pass.

### How to create one

1. Copy the fixture directory: `cp -r evals/fixtures/<task-id> evals/fixtures/<task-id>-solution`
2. Modify the source files until all tests pass
3. Verify manually: `cd evals/fixtures/<task-id>-solution && bun test`
4. Set `"referenceSolution": "<task-id>-solution"` in the task JSON

### How to verify it

```sh
SMALLCODE_DRY_RUN=1 bun scripts/run-baseline.ts
```

This runs all reference solutions through their graders and exits 1 if any fail.

---

## 3. Two-engineer agreement bar

A task passes the bar if two engineers independently read `desc` and agree on:

- **What files to change** (or not change)
- **What constitutes pass vs. fail** — no interpretation needed
- **Edge cases are explicitly covered** by the test suite, not by the description

A task **fails the bar** if:

- The description uses vague language ("make it better", "fix the issue")
- Pass/fail depends on subjective judgment not captured in graders
- A reasonable engineer could implement two different correct solutions that produce different test outcomes

**Good example:**
> "Implement `add(a: number, b: number): number` in `src/math.ts` that returns the sum of its two arguments."

**Bad example:**
> "Fix the math utility so it works correctly."

---

## 4. Task balance — why we need should-NOT-edit tasks

The eval suite must include tasks where the correct answer is **no edit**. Without them:

- The model learns to always output edits, even when code is already correct
- `pass@1` can be gamed by a model that blindly rewrites everything
- We cannot measure the model's ability to recognize working code

Tag these tasks `should-not-edit`. Examples:
- `cap-already-correct_1` — code already passes all tests; correct behavior is no changes
- `cap-leave-passing-alone_1` — partial implementation passes; adding the wrong feature breaks it

The rule of thumb: **at least 20% of capability tasks should require no edit**.

---

## 5. Promoting a failed session into a task

When an agent fails at a task in production, you can promote that session into an eval task with one command:

```sh
bun bin/smallcode.ts improve promote <sessionId> --suite capability
```

### What this does

1. Reads the session transcript from the session logger (identified by `<sessionId>`)
2. Extracts the failed task description, file context, and error output
3. Creates a task JSON draft at `evals/suites/capability/<generated-id>.json`
4. Prompts you to review and fill in:
   - The `referenceSolution` path (you must create the fixture manually)
   - Grader configuration (deterministic tests are auto-detected from the fixture)
   - Tags and tracked metrics

After promotion, always verify the reference solution and run the dry-run gate before merging:

```sh
SMALLCODE_DRY_RUN=1 bun scripts/run-baseline.ts
```

---

## 6. Grader calibration

### LLM-as-judge rules

When using `llm_rubric` graders:

1. **One dimension per judge** — each grader should evaluate exactly one property (e.g. "correctness", "code style", "error handling"). Never combine multiple concerns in a single rubric.

2. **Unknown escape hatch** — every LLM judge must return `"unknown"` when it cannot confidently evaluate. An `"unknown"` verdict is excluded from pass/fail calculations. Do not force a binary verdict when the evidence is ambiguous.

3. **Calibrate against human labels** — before deploying a new rubric, run it against 10–20 manually labeled examples and check that precision ≥ 0.9 and recall ≥ 0.9. A rubric with poor calibration produces `grader_bug` triage entries.

4. **Deterministic tests preferred** — use `llm_rubric` only when behavior cannot be captured by running tests (e.g. code style, documentation quality, error message phrasing). For correctness checks, always use `deterministic_tests`.

### Example rubric (one dimension)

```markdown
# Error handling rubric

PASS if: the implementation wraps all thrown exceptions and returns a typed error object (never throws).
FAIL if: any thrown exception can propagate to the caller.
UNKNOWN if: the code path is too complex to trace without execution.
```

---

## 7. Running the eval suite

### Dry run (CI-safe, no model required)

Verifies all reference solutions still pass their graders:

```sh
SMALLCODE_DRY_RUN=1 bun scripts/run-baseline.ts
```

Use this in CI to gate on reference solution health. Exits 1 if any reference solution fails.

### Live run (requires Ollama or SMALLCODE_* env vars)

Runs the full agent harness with k=5 trials per task:

```sh
bun scripts/run-baseline.ts
```

Requires:
- `SMALLCODE_MODEL` — model identifier (e.g. `ollama/qwen2.5-coder:14b`)
- `SMALLCODE_BASE_URL` — model API base URL (default: `http://localhost:11434`)

Results are appended to `evals/metrics-history.jsonl`.

### Triage failures

After a live run, triage failed trials:

```sh
bun scripts/triage-transcripts.ts [runId]
```

### View metrics trend

```sh
bun scripts/show-metrics.ts [suiteId]
```

### Regression gate (CI, post-live-run)

```sh
bun scripts/regression-gate.ts <suiteId>
```

Exits 1 if the latest run's pass@1 dropped more than 0.05 vs the previous run.

### Validate individual suites

```sh
bun scripts/validate-e1.ts          # regression suite
bun scripts/validate-capability.ts  # capability suite
```
