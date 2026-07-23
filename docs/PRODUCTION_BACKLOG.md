# smallcode — Production-Readiness Backlog

> **Purpose.** This is the authoritative, self-contained work plan to take smallcode from
> "research harness" to "a tool a real developer trusts and reaches for." It is written so an
> agent with **no prior context** and **modest skills** can pick up any task, complete it, and
> track progress. Every task lists exact files, steps, acceptance criteria, and verification
> commands. Do not assume knowledge outside this document and the repo.
>
> Derived from a 4-lens expert panel (product-pragmatist, evals-researcher, devex-skeptic,
> reliability-engineer). Panel verdict: **stop chasing model capability (localization ceiling is
> mapped and confirmed); ship TRUST + DISTRIBUTION.** Sequence: **E1 → E2 → E3/E4 in parallel.**

---

## 0. How to use this document

1. **Pick the next `TODO` task** from the Master Board (Section 4) respecting `Depends-on`. Lower epic
   numbers first (E1 before E2). Within an epic, lower task numbers first.
2. **Read that task's card** (Section 6+). Do exactly the Steps. Meet every Acceptance Criterion.
3. **Run the Verification commands.** All must pass before you mark the task done.
4. **Update this file**: change the task's `Status` in the Master Board AND in its card
   (`TODO → IN-PROGRESS → DONE`). Check the box. Add a one-line `Result:` note to the card.
5. **Update docs** listed in the card's `Docs-to-update` (the repo has a HARD no-drift rule — see 3.4).
6. **Open a PR** (see 3.3). Do **NOT** merge to `main` yourself — request human review.

### Status legend
- `TODO` — not started.
- `IN-PROGRESS` — actively being worked (put your run/PR link in the card).
- `BLOCKED` — cannot proceed; write the blocker in the card.
- `DONE` — all acceptance criteria met + verification green + PR opened.

### Priority
- `P0` — trust floor. A single failure here uninstalls the tool. Do first.
- `P1` — adoption / credibility. Needed to be usable by anyone but you.
- `P2` — compounding capability. Valuable but not blocking.

### Effort (rough, for a modest agent)
- `S` ≤ half a day · `M` 1-2 days · `L` 3-5 days.

---

## 1. Glossary (read before starting)

- **Oracle** — the deterministic test-runner + verdict logic in `src/verify/oracle.ts`. Runs
  `bun test`, parses pass/fail, decides if the repo is green/red/regressed. The source of truth.
- **Guard ("never leave repo worse")** — `runFinalStateGuard` in `src/agent/loop.ts`. After the agent
  loop ends unsolved, it restores the repo to its pre-run state if the run made tests *worse*.
- **Per-turn revert** — `revertFiles` in `src/agent/loop.ts`. Undoes a single turn's edits when that
  turn *regressed* the suite (introduced NEW failures), preserving partial progress otherwise.
- **Edit-apply** — turning the model's SEARCH/REPLACE blocks into disk writes (`applyBatch`).
- **Deterministic rescue / repair** — harness-side last-resort fixers (operator-mutation, literal,
  statement) that brute-force a fix and keep it only if the real oracle goes fully green. Cannot
  "fake-green." See `src/repair/`.
- **Rescue attribution** — recording WHICH mechanism solved a task (model vs harness-rescue vs
  escalation). `TurnRecord.mutationRepair` marks a harness rescue. See `scripts/classify-pass-quality.ts`.
- **pass@k / bootstrap CI** — the measuring stick. `src/eval/stats.ts`. Two results differ only when
  their 95% confidence intervals do NOT overlap. Point estimates alone are noise at small n.
- **Target-lock / target-set** — the bounded set of files the agent is allowed to edit.
- **Fixture** — a small repo with one seeded bug + a test that fails until fixed, under `evals/fixtures/`.

---

## 2. Repo orientation (verified 2026-07-22)

Runtime is **Bun** (not Node). Always use `bun`, `bun test`, `bunx`, `bun install`.

| Area | Path | Notes |
|---|---|---|
| CLI entry | `bin/smallcode.ts` | dispatches subcommands; version from package.json |
| CLI arg parse | `src/cli/args.ts` | `parseArgs()` |
| Commands | `src/cli/commands/` | run.ts, fix.ts, chat.ts, review.ts (diff+undo), config-init.ts, config-models.ts, config-env.ts, selfmanage.ts (update/uninstall) |
| Agent loop | `src/agent/loop.ts` | `runLoop` L695; apply/oracle/guard/revert live here |
| Oracle | `src/verify/oracle.ts` | verdict logic; parsers at L73/L109/L124 |
| Repairs | `src/repair/` | operator-mutation.ts, literal-mutation.ts, read-after-delete.ts |
| Import gate | `src/verify/import-check.ts` | reverts hallucinated imports pre-test |
| Model registry | `src/models/registry.ts` | 6 built-in profiles; id == Ollama model name |
| Config load | `src/config/loader.ts`, `src/config/env.ts` | env vars + `smallcode.config.json` |
| Provider | `src/provider/` | OpenAI-compatible client → Ollama `http://localhost:11434/v1` |
| Eval driver | `scripts/run-baseline.ts` | reads `SMALLCODE_*` env; writes `evals/metrics-history.jsonl` |
| Eval compare | `scripts/compare-runs.ts` | CI-overlap verdict |
| Eval core | `src/eval/` | task-loader, task-runner, trial-env, stats, metrics, graders/ |
| Pass-quality | `scripts/classify-pass-quality.ts` | model-vs-rescue attribution |
| SWE-bench | `scripts/vendor-swebench.ts` (ingest), `scripts/run-swebench.ts` (honest runner) | runnable-subset only |
| Suites | `evals/suites/` | capability, multifile, realrepo (22), swebench-lite |
| Public docs | `index.html`, `docs/architecture.html`, `docs/llms.html` | HARD no-drift rule |
| Other docs | `README.md`, `docs/ROADMAP.md`, `docs/harness-engineering-roadmap.md` | keep in sync |

---

## 3. Conventions every task MUST follow

### 3.1 Test / verify commands
- Full test suite: `bun test` (must stay green; ~1144 tests as of 2026-07-22).
- One file: `bun test tests/<file>.test.ts`.
- Types: `bunx tsc --noEmit` (must be clean).
- Lint: `bunx biome check .` (or `bun run check`).
- Dry-run eval (no model needed): `SMALLCODE_DRY_RUN=1 SMALLCODE_SUITE=realrepo bun scripts/run-baseline.ts` → exits 0 if reference solutions validate.

### 3.2 Before ANY commit
Run these two (they reset transient eval artifacts so they never get committed):
```bash
git checkout evals/metrics-history.jsonl 2>/dev/null || true
rm -rf evals/transcripts
```

### 3.3 Branch / PR protocol
- `main` is protected. Never commit directly to it.
- New branch per task: `git checkout -b <type>/<slug>` (e.g. `feat/atomic-apply-journal`, `fix/revert-hash-verify`).
- Commit message ends with the co-author trailer used in this repo (check `git log -1` for the exact line).
- Open a PR with `gh pr create`. **Do NOT `--admin --merge`.** Request human review; a human merges.

### 3.4 HARD docs rule (non-negotiable — from CLAUDE.md)
Every `.html`/`.md` that references a thing you changed MUST be updated in the same PR. On each task,
grep the doc set for the feature/flag/command/number you touched and update every match:
```bash
grep -rniE "<thing you changed>" README.md index.html docs/*.html docs/*.md
```
Update `docs/architecture.html` footer timestamp to today. If genuinely no doc applies, write
`docs: no public-page impact` in the commit body so the skip is deliberate.

### 3.5 Discipline (from evals-researcher lens — avoid fooling yourself)
- Never report a "win" without stating WHICH mechanism fired (model / harness-rescue / escalation).
- Never fold a rescue or escalation success into "the small model solved it."
- Treat the synthetic realrepo suite (~0.94) as **saturated**; new gains there are noise. Real signal
  comes from real-repo dogfood or genuinely new task distributions.
- Validate any new rescue archetype at **n ≥ 8** with CIs before claiming it works.

---

## 4. Master Board (single source of truth for status)

Update the `Status` column as you work. `Dep` = must be DONE first.

| ID | Epic | Task | Pri | Eff | Dep | Status |
|----|------|------|-----|-----|-----|--------|
| E1-T1 | Trust | Oracle full-fidelity regression guard + slice audit | P0 | S | — | ☑ DONE |
| E1-T2 | Trust | Atomic multi-file apply + write-ahead journal (crash recovery) | P0 | L | E1-T1 | ☑ DONE |
| E1-T3 | Trust | Verified revert (hash-check restoration, fail-closed) | P0 | M | — | ☑ DONE |
| E1-T4 | Trust | Guard-cannot-be-bypassed audit + fail-closed wrapper | P0 | M | E1-T3 | ☑ DONE |
| E1-T5 | Trust | Failure UX: honest "couldn't fix + why" + guard-confidence field | P1 | M | — | ☑ DONE |
| E1-T6 | Trust | Interleaved-human-edit undo-scope test | P1 | S | — | ☑ DONE |
| E2-T1 | Dist | `smallcode doctor` preflight command | P1 | M | — | ☐ TODO |
| E2-T2 | Dist | Ollama health check before run | P1 | S | — | ☐ TODO |
| E2-T3 | Dist | Auto model-pull when configured model missing | P1 | M | E2-T2 | ☐ TODO |
| E2-T4 | Dist | Model-id validation (registry + local ollama) | P1 | S | — | ☐ TODO |
| E2-T5 | Dist | One-command bootstrap install (bun+ollama+model) | P1 | M | E2-T1 | ☐ TODO |
| E2-T6 | Dist | Sane first-run default model = qwen2.5-coder:3b | P2 | S | — | ☐ TODO |
| E3-T1 | Bench | Honest published numbers with mechanism attribution | P1 | M | — | ☐ TODO |
| E3-T2 | Bench | `run-swebench` polish + runnable-subset report | P1 | L | — | ☐ TODO |
| E3-T3 | Bench | Real-repo dogfood harness on smallcode's own history | P2 | M | — | ☐ TODO |
| E4-T1 | Rescue | Generalize repair into a pluggable archetype interface | P2 | M | — | ☐ TODO |
| E4-T2 | Rescue | Add validated new rescue archetypes (n≥8 gated) | P2 | L | E4-T1 | ☐ TODO |
| E5-T1 | Discipline | Mechanism attribution in every run/eval report | P1 | S | — | ☐ TODO |
| E5-T2 | Discipline | Position target user + honest limits in docs | P1 | S | — | ☐ TODO |
| E5-T3 | Discipline | Docs-drift CI check script | P2 | M | — | ☐ TODO |

---

## 5. Milestones

- **M1 — "Safe to run unattended" (E1 all).** The pitch that survives a 7B model's mediocrity:
  worst case it no-ops and never corrupts your repo. Ship before any marketing.
- **M2 — "Zero-to-run in 5 minutes" (E2-T1..T5).** A stranger can install and fix a bug without
  reading the source. Gates every other direction being seen.
- **M3 — "Credible, non-hyped numbers" (E3-T1, E3-T2, E5-T1, E5-T2).** Publish what it can and
  cannot do, with mechanism attribution. Credibility is the moat, not benchmark bragging.
- **M4 — "More bugs fixed, honestly" (E4).** Grow the deterministic-rescue coverage — the only lever
  with a replicated win record.

---

## 6. EPIC E1 — Trust floor (P0, panel's unanimous #1)

**Why this epic first:** A cloud tool that fails wastes a turn; an offline tool that silently leaves a
repo *worse* burns the one thing local-small-model tools exist to offer — safety and control. A real
truncation bug already shipped once (the oracle sliced test output to 4000 chars, so a verbose failure
made the guard read a false "0 red" and it left the repo worse). That class of silent guard failure is
the existential risk. Everything else in this backlog rides on this floor being airtight.

**Current state (verified):** the truncation bug is FIXED — verdict parsers now receive full output
(`captureTestBaseline` routes `fullOutput` at `src/verify/oracle.ts:201-204`; the `.slice()` calls at
L257, L342-349, L398 feed model-facing *feedback* only, not verdicts). Repair passes are wrapped in
try/catch. The OPEN risks are: (a) non-atomic file-by-file apply can leave a half-written repo if the
process dies mid-batch, with no revert triggered; (b) revert restores from an in-memory snapshot but
never verifies the bytes landed; (c) the tool `write_file` path is separate from `applyBatch`.

---

### E1-T1 — Oracle full-fidelity regression guard + slice audit  ·  P0 · S · Status: ☑ DONE
**Goal:** Make it impossible to *reintroduce* the truncation bug without a test screaming.

**Files**
- `src/verify/oracle.ts` — parsers `parseFailingTestIds` (L73), `parseRedCount` (L109), `hasLoadError` (L124); `runBunTest` slice (L257); `captureTestBaseline` full-parse (L201-204); `runTieredOracle` slices (L342-349, L398).
- `tests/oracle-truncation.test.ts` — extend.

**Steps**
1. Read `src/verify/oracle.ts` fully. Confirm every place a verdict (red count / failing ids / load
   error / regression) is decided reads the FULL output, never a `.slice()`d string.
2. Add an end-to-end test to `tests/oracle-truncation.test.ts`: build a synthetic `bun test` output where
   the `X pass / Y fail` summary sits **past character 4000** (pad with a long stack trace). Feed it
   through `captureTestBaseline` and `runTieredOracle` (mock the spawn to return your synthetic output)
   and assert the verdict sees the real red count — not 0.
3. Add a guard test that greps `src/verify/oracle.ts` for `.slice(`/`.substring(` and asserts each such
   line is annotated with a `// feedback-only (not a verdict input)` comment. This forces a future editor
   to consciously mark any new truncation. (Implement as a unit test that reads the file text.)
4. Annotate the three existing slice sites (L257, L342-349, L398) with that exact comment if not present.

**Acceptance criteria**
- New tests fail if any verdict parser is fed a truncated string.
- Guard test fails if a new unannotated `.slice(`/`.substring(` appears near output handling.
- `bun test tests/oracle-truncation.test.ts` green; full `bun test` green; `bunx tsc --noEmit` clean.

**Verification**
```bash
bun test tests/oracle-truncation.test.ts && bun test && bunx tsc --noEmit
```
**Docs-to-update:** `docs/architecture.html` (oracle/early-stop section + footer date) if you describe the guard test; else `docs: no public-page impact`.
**Rollback:** tests-only + comments; revert the test file.
**Result:** _(2026-07-22)_ DONE. Audited `src/verify/oracle.ts`: every verdict input (`parseRedCount`, `parseFailingTestIds`, `hasLoadError`, pass/`newFailures` counts) already reads `fullOutput` in both `captureTestBaseline` and `runTieredOracle` — confirmed the truncation bug stays fixed, this task is regression-proofing. Added to `tests/oracle-truncation.test.ts`: (a) 3 end-to-end tests driving `captureTestBaseline` + `runTieredOracle` with `Bun.spawnSync` mocked to emit a verbose failure whose `X pass / Y fail` summary sits **past char 4000** — asserts real counts (redCount 15, not truncated 0), `regressed:true`, and no false-`solved` on a past-slice green suite; (b) a source-guard test that fails if any `.slice(`/`.substring(` in oracle.ts lacks the `// feedback-only (not a verdict input)` marker. Annotated all 7 slice sites (L257, 342, 344, 346, 348, 349, 398). **Measured:** mutation-test (reintroduce `parseRedCount(fullOutput.slice(0,4000))`) turns the end-to-end test RED → the guard provably bites; reverted. `bun test tests/oracle-truncation.test.ts` 6/6 green; full `bun test` 1148/0; `bunx tsc --noEmit` clean. `docs: no public-page impact` (tests + comments only; no feature/flag/behavior change).

---

### E1-T2 — Atomic multi-file apply + write-ahead journal (crash recovery)  ·  P0 · L · Status: ☑ DONE
**Goal:** A process kill / OOM / Ollama disconnect mid-apply must never leave a half-written repo with
no recovery. This is the reliability lens's predicted *next* silent-failure class.

**Problem (verified):** `applyBatch` (`src/agent/loop.ts:1008`) writes file-by-file via `writeFile`
(`src/agent/loop.ts:587`). If it applies file 1 then crashes before file 2, the guard/oracle step never
runs, so nothing reverts — the repo is left half-edited. The tool `write_file` path
(`src/agent/loop.ts:1110`) has the same exposure.

**Design (write-ahead journal + replay):**
1. New module `src/agent/journal.ts`. Before the FIRST write of any turn, write a journal file (outside
   the repo, e.g. under `os.tmpdir()/smallcode-journal/<repoHash>.json`, or a `.smallcode/journal.json`
   that is gitignored) recording, for every file the batch will touch: absolute path + original bytes
   (or "did-not-exist" marker for new files) + a run id + a `status: "in-progress"`.
2. Apply all writes. On successful completion of the apply+oracle+guard sequence, mark the journal
   `status: "clean"` (or delete it).
3. On the NEXT `smallcode` invocation (and inside eval `createTrialEnv`), check for an `in-progress`
   journal for this repo. If found, the previous run did not reach a clean terminal state → **replay the
   journal to restore original bytes / delete created files**, then delete the journal. Log clearly:
   `smallcode: recovered an interrupted run — restored N files to their pre-run state.`
4. Route BOTH `applyBatch` and the tool `write_file` path through the journal (single choke point).

**Files**
- new `src/agent/journal.ts` (write/mark-clean/replay/detect).
- `src/agent/loop.ts` — call journal.begin() before first write (near L1008 and L1110), journal.markClean() after guard (after L1690), and journal.recoverIfNeeded() at run start (near L695).
- `bin/smallcode.ts` or `src/cli/commands/run.ts` — surface the recovery message to the user.
- `src/eval/trial-env.ts` — trials run in throwaway tmpdirs so recovery is a no-op there; ensure the journal path is per-repo and does not leak across trials.
- new `tests/agent-journal.test.ts`.

**Acceptance criteria**
- Simulate a crash: begin a batch, write file 1, throw before file 2, then call `recoverIfNeeded()` →
  file 1 is restored to original bytes, created files deleted, journal removed.
- A clean run leaves no journal (or a `clean` one) behind.
- New-file case: a file created during the crashed run is deleted on recovery.
- No behavior change for successful runs (same diffs, same tests).
- `bun test` green, `bunx tsc --noEmit` clean.

**Verification**
```bash
bun test tests/agent-journal.test.ts && bun test && bunx tsc --noEmit
# manual: start a run, kill -9 the process mid-apply, run `smallcode diff` → should show recovery, clean tree
```
**Docs-to-update:** `docs/architecture.html` (add crash-recovery to the edit-apply/guard flow diagram + footer date); `docs/llms.html` (module map: add `journal.ts`); `README.md` (safety guarantees section if present).
**Rollback:** feature-flag the journal (`SMALLCODE_APPLY_JOURNAL`, default ON); set OFF to restore prior behavior.
**Result:** _(2026-07-22)_ DONE (PR #152). New module `src/agent/journal.ts`: `recordOriginals` (persist pre-run bytes / did-not-exist marker, first-seen-wins per path, lazy journal create), `recoverIfNeeded` (replay a surviving in-progress journal — restore originals, delete created files, **best-effort per entry** so one unrestorable file never aborts recovery or throws into the run), `markClean`, `hasPendingJournal`, `journalPathFor` (= `os.tmpdir()/smallcode-journal/<sha256(repoRoot)[:16]>.json`, per-repo keyed → eval trials never collide). Wired into `loop.ts`: `recoverIfNeeded` + `beginRun` at run start (BEFORE the baseline capture, so it reflects the restored tree), a journaling `writeFileFn` wrapper for `applyBatch`, `recordOriginals` before the `write_file` TOOL path executes, `markClean` right before `return` (after the guard — NOT in a finally, so a crash correctly leaves the journal). Flag `SMALLCODE_APPLY_JOURNAL` (default ON) in `src/config/env.ts` + `ENV_REGISTRY`. **Design note:** true byte-atomic multi-file write is impossible file-by-file; the journal delivers the equivalent — apply that is atomic at *run-granularity across a crash* (next run rolls back a half-written repo). **Measured:** module mutation-test (remove first-seen guard) flips the cross-turn test RED → restore green; full `bun test` **1160/0 on both bun 1.3.12 and 1.3.14** AND under reversed file-order (ubuntu-like) — zero cross-test journal leak; `bunx tsc --noEmit` clean. Adversarial review found ONE real defect (fixed): the `smallcode chat` REPL continues the process after a caught `runLoop` throw (unlike `run.ts`, which `process.exit(1)`s → journal survival is correct crash semantics), so a thrown task N would leave an in-progress journal that task N+1 silently replays, rolling back N's writes. Fix: `journal.ts` exports self-contained `recoverRepo(repoRoot)` (builds its own path-safe, traversal-guarded write/rm); `chat.ts`'s catch calls it to roll the failed task back to pre-task state and report `rolled back N partial edit(s)`, keeping each REPL task atomic (test added). Review confirmed all other axes sound (baseline-before-recovery, single-return markClean, BoN/eval isolation via sequential-await + process.exit + per-attempt trial dirs, first-seen-wins across turns AND within a batch, effectivePath journaling, guard-before-markClean, no concurrency race). Docs: architecture.html (new crash-recovery section + flow), llms.html (module-map row), README.md (env entry), env-registry count 23→24. Final: full `bun test` 1161/0 on both bun 1.3.12 and 1.3.14; tsc clean.

---

### E1-T3 — Verified revert (hash-check restoration, fail-closed)  ·  P0 · M · Status: ☑ DONE
**Goal:** Never *assume* a revert worked. Prove the bytes are back.

**Problem (verified):** `revertFiles` (`src/agent/loop.ts:258`) and `runFinalStateGuard`
(`src/agent/loop.ts:658`, verifies suite at L679) restore from captured `originalContent` and then re-run
the oracle, but never compare the on-disk bytes to the captured original. A partial or failed write is
assumed successful from the absence of a throw.

**Steps**
1. In `revertFiles`, after writing each `originalContent` back, re-read the file and compare bytes/hash to
   the intended original. On mismatch, do NOT silently continue — surface a hard error and mark the run
   `unsafe` (fail-closed): tell the user the repo may be in an inconsistent state and how to recover
   (git, or the E1-T2 journal).
2. In `runFinalStateGuard`, after restore, in addition to the suite re-check, assert every restored file's
   hash matches its pristine snapshot hash. Fail-closed on mismatch.
3. Add a `restoreVerified: boolean` to the run result so callers/UX can report it.

**Files**
- `src/agent/loop.ts` — `revertFiles` (L258), `pristineRunSnapshot` (L297), `runFinalStateGuard` (L658-679).
- `tests/loop-final-state-guard.test.ts` (extend), new assertions in `tests/applier-feedback-revert.test.ts`.

**Acceptance criteria**
- A simulated failed/partial write during revert produces a hard, visible error (not a silent pass).
- Successful revert sets `restoreVerified: true`.
- `bun test` green; `bunx tsc --noEmit` clean.

**Verification**
```bash
bun test tests/loop-final-state-guard.test.ts tests/applier-feedback-revert.test.ts && bun test
```
**Docs-to-update:** `docs/architecture.html` (guard/revert description + footer). 
**Rollback:** revert the added checks.
**Result:** _(2026-07-22)_ DONE (PR #151). `revertFiles` now takes an optional `readFileFn`, reads every restored file back, byte-compares to the captured original, and returns `{ verified, mismatched }` (`src/agent/loop.ts`). `runFinalStateGuard` threads it (real disk read by default, injectable for tests), also confirms each created file was actually deleted, records `finalStateReverted.restoreVerified` (new field in `src/agent/types.ts`), and on mismatch logs a fail-closed `[final-state-guard] UNSAFE …` line naming the path + recovery (`git checkout -- .` / journal). The per-turn revert carries the same read-back check. Used direct byte-compare (content already in memory) rather than hashing — exact and simpler. **Measured:** mutation-test (force `verified:true`) flips exactly the 4 new fail-closed tests RED, then restore → green. `bun test tests/loop-final-state-guard.test.ts tests/applier-feedback-revert.test.ts` 36/36; full `bun test` 1153/0 on **both bun 1.3.12 and 1.3.14**; `bunx tsc --noEmit` clean. Adversarial review: clean. Docs: `docs/architecture.html` guard section + footer updated.

---

### E1-T4 — Guard-cannot-be-bypassed audit + fail-closed wrapper  ·  P0 · M · Status: ☑ DONE
**Goal:** No code path — BoN, escalation, tool `write_file`, any repair, or an unhandled throw — can end a
run with the repo edited but the guard skipped.

**Context:** A prior real hole (PR #127) let a repair-pass oracle throw escape `runLoop` and skip the
guard. Repairs are now try/caught, but audit ALL paths.

**Steps**
1. Trace every terminal exit of `runLoop` (`src/agent/loop.ts:695`..end, guard call at L1690). Enumerate
   every `return`/`throw` after the first disk write.
2. Wrap the apply→oracle→guard sequence so that on ANY exception the guard (or the E1-T2 journal replay)
   runs before propagating — i.e., fail-closed: an internal error leaves the repo untouched, never worse.
   Use `try { ... } finally { ensureGuardOrRecover() }`.
3. Confirm the BoN loop (`src/agent/bestofn-loop.ts`) and escalation apply the same terminal guard per
   attempt AND for the whole run.
4. Confirm the tool `write_file` path (L1110) is covered by the same terminal guarantee.

**Acceptance criteria**
- A forced throw inside each of: an executor turn, a repair pass, a BoN attempt, the tool write path →
  the run ends with the repo NO WORSE than baseline (test proves it).
- `bun test` green; `bunx tsc --noEmit` clean.

**Verification**
```bash
bun test tests/loop-repair-throw-restore.test.ts && bun test
```
**Docs-to-update:** `docs/architecture.html` (guard coverage) + footer.
**Rollback:** revert the wrapper.
**Result:** _(2026-07-22)_ DONE (PR #153). **Audit (step 1):** the #152 review already traced every terminal path — `runLoop` has exactly one `return state`; per-turn executor throws AND the `write_file` tool path are caught by the per-turn try/catch (guard still runs); repair-pass throws by the repair try/catch (PR #127); BoN/escalation callers `process.exit(1)` on throw (→ next-run journal replay) or use per-attempt fresh trial dirs; the `chat` REPL now reconciles the journal on a caught throw (E1-T2). The ONE remaining in-process gap: the guard call + its `saveState` + `markClean` sit BELOW the repair try/catch, so a throw there (e.g. `captureTestBaseline`'s `bun test` spawn failing, a disk error on save) escaped `runLoop`. **Fix (step 2):** wrapped the terminal guard/finalize in try/catch — on ANY throw it replays the write-ahead journal (`recoverIfNeeded`) to roll the run back to its exact pre-run state before propagating (fail-closed: repo left no worse than baseline, never half-reverted). Added a per-call `finalStateGuardFn` seam to `LoopDependencies` (no global state) so a test can force the guard to throw. **Measured:** new integration test drives a full `runLoop` (red baseline, model creates a junk file, forced-throwing guard) → asserts the created file is deleted (journal rollback) and the throw propagates; mutation-test (make the fail-closed catch skip recovery) flips it RED → restore green. Full `bun test` **1162/0 on both bun 1.3.12 and 1.3.14**; `bunx tsc --noEmit` clean. Docs: architecture.html fail-closed-guard paragraph + footer. **Note:** chose a targeted terminal-wrapper over the card's literal whole-`runLoop` try/finally — the journal already delivers whole-run rollback for every uncaught throw (next-run or caller-side), and the wrapper closes the one in-process guard-tail gap; re-indenting the entire 1000-line loop body would be a high-risk diff for no additional guarantee.

---

### E1-T5 — Failure UX: honest "couldn't fix + why" + guard-confidence field  ·  P1 · M · Status: ☑ DONE
**Goal:** When the model fails, say so plainly and legibly. Silent mediocrity (a confidently-wrong diff
with no "this might be wrong" signal) kills trust faster than an honest failure.

**Steps**
1. On an unsolved run, `smallcode run` output must clearly state: "Could not fix. Repo left unchanged
   (guard restored N files / no edits kept)." Include the last failing test names and the reason
   (out of turns / no green candidate / import gate reverted / etc.).
2. Add a `guardVerdict`/`confidence` line to run output: whether the guard fired, whether restore was
   verified (from E1-T3), and whether a rescue vs the model produced any kept change.
3. When a fix IS applied, print a one-line "how this was solved" attribution (model / operator-mutation
   rescue / statement-repair rescue / escalated to <model>). See E5-T1.

**Files**
- `src/cli/commands/run.ts`, `src/cli/commands/review.ts` (diff), agent run-result plumbing in `src/agent/loop.ts`, output types.

**Acceptance criteria**
- An unsolved run prints an explicit "couldn't fix + why" block and a clean-tree confirmation.
- A solved run prints the mechanism attribution.
- `--json` output carries the same fields (structured).
- `bun test` green; `bunx tsc --noEmit` clean.

**Verification**
```bash
bun test && bunx tsc --noEmit
# manual: run on a bug the 3B can't fix → verify the honest failure block + unchanged tree
```
**Docs-to-update:** `README.md` (output examples), `docs/llms.html` (CLI contract), `index.html` if it shows sample output.
**Result:** _(2026-07-22)_ DONE (PR #154). Added pure, exported `summarizeOutcome(finalState, escalatedTo?) → RunOutcomeSummary` in `run.ts`: derives `solved`, `mechanism` (`model` / `harness-rescue` — a turn carries `mutationRepair` / `escalated` — solved by a ladder rung / `none`), `guardFired` + `restoreVerified` + `filesRestored` (from `finalStateReverted`, E1-T3), `failingTests` (guard regression list, else last turn's revert/diagnostic), and a human `reason`. Renderers `renderSolvedAttribution` (one-line "how solved") and `renderFailureBlock` ("Could not fix — why; tree state; still-failing tests"). Wired into `run.ts`: solved path prints the attribution, unsolved path prints the honest failure block before the tone message; `solvedByEscalation` threaded from the escalation result. `--json` (`formatRunJson` + `RunJsonResult`) extended with the six new fields. **Measured:** mutation-test (ignore `mutationRepair`) flips the harness-rescue test RED → restore green; new `tests/run-outcome.test.ts` (13) + updated `tests/run-json.test.ts`. Full `bun test` **1171/0 on both bun 1.3.12 and 1.3.14**; `bunx tsc --noEmit` clean. Docs: README `--json` field list + honest-output note, llms.html run-contract row. (Mechanism attribution overlaps E5-T1 — this is the run-time surface; E5-T1 remains the offline pass-quality analysis.)

---

### E1-T6 — Interleaved-human-edit undo-scope test  ·  P1 · S · Status: ☑ DONE
**Goal:** Prove `undo` only touches the agent's own files, never the user's concurrent edits. (#68 scoped
undo to agent changes; add the test that simulates interleaving.)

**Files:** `src/cli/commands/review.ts` (undoCommand), new `tests/undo-scope-interleaved.test.ts`.

**Steps**
1. Set up a repo state where the agent edits file A while the user has separately edited file B (and also
   made a different edit to file A).
2. Run `undo`. Assert file B is untouched, and file A reverts only the agent's hunk / falls back to a safe
   refusal if it cannot cleanly separate them (never clobber user work).

**Acceptance criteria:** test proves user edits survive undo; ambiguous overlap fails safe (refuses, warns).
**Verification:** `bun test tests/undo-scope-interleaved.test.ts && bun test`
**Docs-to-update:** `README.md` undo section if behavior clarified.
**Result:** _(2026-07-22)_ DONE (PR #154). Test-only — the #68 behavior already holds: `recordAgentChanges` computes the manifest as `(dirty after) − (dirty before run)`, so any file the user had already dirtied is EXCLUDED and `undo` never `git restore`s it. New `tests/undo-scope-interleaved.test.ts` (2) drives the interleaving directly: user pre-edits B and A, agent then edits A + a clean file D + creates C. Asserts `revertAgentChanges` reverts only D (agent-only) + deletes C (agent-created); B and A are left byte-identical (user work survives, the ambiguous overlap on A fails safe = left alone, never clobbered); a purely-user session records nothing → undo is a no-op. **Measured:** mutation-test (drop the `before` exclusion so ALL dirty files are claimed) flips both tests RED (A would be clobbered) → restore green. `bun test` green; behavior unchanged so `docs: no public-page impact` for this task (README undo section already accurate).

---

## 7. EPIC E2 — Distribution (P1, the adoption gate)

**Why:** DevEx brutal truth — if `curl | sh` → working agent (Ollama running, model pulled) isn't under
~5 minutes, nobody reaches the harness's strengths. Today there are **7 manual prerequisites** and the
tool fails at the first inference call if Ollama is down or the model isn't pulled (no health check, no
auto-pull, no model validation).

### E2-T1 — `smallcode doctor` preflight command  ·  P1 · M · Status: ☐ TODO
**Goal:** One command that diagnoses the whole setup and prints exact fix-its.
**Files:** new `src/cli/commands/doctor.ts`; register in `bin/smallcode.ts` + `src/cli/args.ts`.
**Checks (each prints ✓/✗ + the fix command on ✗):** bun on PATH & version; Ollama installed; Ollama
server reachable at the configured base URL (`GET /api/tags`); the active model present in `ollama list`;
config file valid (parses, model id is registered); repo is a git repo with a test runner.
**Acceptance:** on a broken setup each failing check prints the copy-pasteable fix; exit non-zero if any
P0 check fails. `bun test tests/cli-doctor.test.ts` green.
**Verification:** `bun bin/smallcode.ts doctor` on a clean machine mock; `bun test && bunx tsc --noEmit`.
**Docs-to-update:** `README.md` quick-start (lead with `smallcode doctor`), `docs/llms.html` command list.
**Result:** _(fill in when done)_

### E2-T2 — Ollama health check before run  ·  P1 · S · Status: ☑ DONE
**Goal:** Fail fast with a human message if Ollama is unreachable, instead of a cryptic inference timeout.
**Files:** `src/provider/` (client), `src/cli/commands/run.ts`, `fix.ts`, `chat.ts`.
**Steps:** before the first model call, `GET {baseUrl}/../api/tags` (or `/v1/models`) with a short timeout;
on failure print `Ollama not reachable at <url> — is 'ollama serve' running?` and exit cleanly.
**Acceptance:** server down → clean actionable error, no stack trace, non-zero exit. `bun test` green.
**Docs-to-update:** `README.md` troubleshooting.
**Result:** _(2026-07-23)_ DONE (PR #157). New shared `src/models/ollama.ts` (the native-API layer underpinning all of E2 — `pingOllama`/`listOllamaModels`/`modelIsPulled`/`pullOllamaModel`, injectable fetch+spawn, derives the native root by stripping `/v1`). Preflight added to `run.ts` (covers `fix`, which delegates) and `chat.ts`: before the provider is used, `pingOllama` (2s timeout) → on failure `progress.showError(ollamaUnreachableMessage(...))` + `process.exit(1)`. `ollamaUnreachableMessage` is pure/exported (names the native URL, the error, `ollama serve`, and `smallcode doctor`). **Measured:** 13 tests for the ollama module (ping ok/500/ECONNREFUSED/timeout, list parse+error, isPulled tag matching, pull exit0/nonzero/throw via injected fetch+runner) + 3 for the message; **live smoke** against a dead port printed the clean actionable error and exited before planning (no stack). Full `bun test` 1188/0 on bun 1.3.12 and 1.3.14; tsc clean. Docs: README troubleshooting.

### E2-T3 — Auto model-pull when configured model missing  ·  P1 · M · Dep: E2-T2 · Status: ☐ TODO
**Goal:** If the active model isn't in `ollama list`, offer to `ollama pull` it (auto with `--yes`).
**Files:** `src/provider/` or a new `src/models/ensure-model.ts`; call from `run.ts`/`fix.ts`.
**Steps:** query `ollama list`; if missing, prompt `Model <id> not found. Pull now (~N GB)? [y/N]` (auto-yes
under `--yes`); stream pull progress; then proceed. Never auto-pull silently in a non-interactive run
unless `--yes`.
**Acceptance:** missing model → guided pull → run proceeds; declined → clean exit with instructions.
`bun test` green (mock the pull).
**Docs-to-update:** `README.md`, `index.html` quick-start (can drop the manual pull step).
**Result:** _(fill in when done)_

### E2-T4 — Model-id validation (registry + local ollama)  ·  P1 · S · Status: ☐ TODO
**Goal:** Catch a typo'd/absent model id at config time, not at first inference.
**Files:** `src/cli/commands/config-init.ts`, `src/models/registry.ts`, `run.ts`.
**Steps:** validate `--model`/config model against the registry (`ModelRegistry.has`) AND against
`ollama list`; warn on registered-but-not-pulled (→ E2-T3) and error on unknown id with the list of known ids.
**Acceptance:** unknown id → clear error listing valid ids; registered-but-unpulled → routed to E2-T3.
**Docs-to-update:** `README.md` config section.
**Result:** _(fill in when done)_

### E2-T5 — One-command bootstrap install  ·  P1 · M · Dep: E2-T1 · Status: ☐ TODO
**Goal:** `curl … | sh` gets a brand-new machine to a working `smallcode run` (optionally installing Bun +
Ollama + pulling the default model), then runs `smallcode doctor` at the end.
**Files:** `install.sh` (the GitHub-hosted installer), `README.md`.
**Steps:** detect missing Bun → offer install; detect missing Ollama → print/perform OS-appropriate install;
optionally pull `qwen2.5-coder:3b`; finish by invoking `smallcode doctor`. Keep every network/OS action
behind a confirmation unless `--yes`/non-interactive.
**Acceptance:** on a clean VM, one command → `smallcode doctor` all-green. Document the exact commands.
**Docs-to-update:** `README.md` install section, `index.html` quick-start.
**Result:** _(fill in when done)_

### E2-T6 — Sane first-run default model  ·  P2 · S · Status: ☐ TODO
**Goal:** `smallcode config init` should default to `qwen2.5-coder:3b` (fast, recommended) rather than
`vibethinker-3b` (slow reasoner, think-only spiral risk).
**Files:** `src/cli/commands/config-init.ts` (default model), README/docs examples.
**Acceptance:** fresh `config init` writes `qwen2.5-coder:3b`; tests updated.
**Docs-to-update:** `README.md`, `docs/llms.html`.
**Result:** _(fill in when done)_

---

## 8. EPIC E3 — Honest benchmark & credibility (P1)

**Why:** Devs are numb to benchmark claims. smallcode's credibility play is the OPPOSITE of hype: publish
what it can and cannot do, with mechanism attribution, real oracles, no fabricated numbers.

### E3-T1 — Honest published numbers with mechanism attribution  ·  P1 · M · Status: ☐ TODO
**Goal:** The public pages show real pass@k + CIs AND the model-vs-rescue-vs-escalation split, so no
number overstates the *model*.
**Files:** `scripts/classify-pass-quality.ts` (attribution), `scripts/run-baseline.ts` (emit the split),
`index.html`, `docs/architecture.html` (tables).
**Steps:** run the realrepo suite at n≥8; produce a table per task: pass@1 [CI] + how solved
(model / operator-mutation / statement-repair / escalation). Publish with a plain-English "what it can't
do" section (localization ceiling; multi-file; large refactors).
**Acceptance:** every published number is reproducible by a documented command and labeled by mechanism;
no aggregate hides a rescue-driven win.
**Verification:** `SMALLCODE_SUITE=realrepo SMALLCODE_EVAL_N=8 bun scripts/run-baseline.ts` then
`bun scripts/classify-pass-quality.ts`.
**Docs-to-update:** `index.html`, `docs/architecture.html` (+footer), `README.md`.
**Result:** _(fill in when done)_

### E3-T2 — `run-swebench` polish + runnable-subset report  ·  P1 · L · Status: ☐ TODO
**Goal:** Turn the existing honest SWE-bench-Lite runner into a repeatable, documented real-repo number
(runnable subset only; env-unavailable instances reported as skipped, never fake-0).
**Files:** `scripts/run-swebench.ts`, `scripts/vendor-swebench.ts`, `evals/suites/swebench-lite/`, docs.
**Steps:** document the exact env setup for the runnable subset; produce pass@1 + edit-format-% + skip
count; wire attribution (E5-T1). Keep the honest-scope markers.
**Acceptance:** a documented command reproduces the reported subset number + skip count; no fabricated
totals.
**Docs-to-update:** `docs/architecture.html` benchmark section, `README.md`, `index.html`.
**Result:** _(fill in when done)_

### E3-T3 — Real-repo dogfood harness on smallcode's own history  ·  P2 · M · Status: ☐ TODO
**Goal:** Highest-fidelity real test: revert a real past multi-file fix commit, have smallcode re-fix it,
smallcode's own `bun test` is the oracle.
**Candidates (from git history):** `a6f68cc` (#127, loop.ts+index.ts), `06545f9` (#125, 6 files),
`55e1763` (#129, env.ts+watchdog.ts), plus `d94c7db` (single-file control).
**Files:** new `scripts/dogfood-history.ts`, new suite `evals/suites/dogfood/`.
**Steps:** for each commit, script a src-only revert (keep the guarding test), run the agent, grade with
the existing test. Report pass + mechanism attribution. Label each cross-file vs single-site.
**Acceptance:** reproducible dogfood run over ≥3 real commits with attributed results.
**Docs-to-update:** `docs/architecture.html` (eval harness), `README.md`.
**Result:** _(fill in when done)_

---

## 9. EPIC E4 — Deterministic-rescue library (P2, the only proven capability lever)

**Why:** Model-side levers are exhausted; deterministic rescues are the one mechanism class with a
replicated, unfakeable win record (operator-mutation cracked mri 0.00→0.88 CI-significant). Each new
archetype is permanent, can't fake-green (requires full-green real oracle), and compounds. BUT: gate every
new archetype to genuinely GENERAL defects, validate at n≥8, and attribute honestly (else it's eval-gaming).

### E4-T1 — Generalize repair into a pluggable archetype interface  ·  P2 · M · Status: ☐ TODO
**Goal:** Extract the shared pattern (enumerate candidates → scope to locked range/editable set → for each:
write → run real oracle → revert if not fully green → keep first green → record `mutationRepair`
attribution) into one interface so new archetypes are small additions.
**Files:** `src/repair/operator-mutation.ts`, `literal-mutation.ts`, `read-after-delete.ts`, new
`src/repair/archetype.ts` (interface + driver); `src/agent/loop.ts` repair call sites (L358/473/583).
**Acceptance:** existing three repairs reimplemented on the interface with identical behavior (all current
repair tests still green); adding a new archetype requires only an `enumerate`+`apply` pair.
**Verification:** `bun test tests/*repair* tests/*mutation* && bun test && bunx tsc --noEmit`.
**Docs-to-update:** `docs/architecture.html` (edit-format/repair pipeline), `docs/llms.html` (module map).
**Result:** _(fill in when done)_

### E4-T2 — Add validated new rescue archetypes (n≥8 gated)  ·  P2 · L · Dep: E4-T1 · Status: ☐ TODO
**Goal:** Add archetypes for common, general, deterministically-checkable bug shapes. Candidates to
evaluate (pick those that fire on GENERAL defects, not one fixture): swapped function arguments;
off-by-one on `.length`/index bounds; wrong boolean default (`true`↔`false` return); missing `await`.
**Process per archetype (MANDATORY):** (1) write a conservative detector; (2) validate on ≥8 trials with
CIs that it moves a real floor and is INERT elsewhere (run the full realrepo suite, confirm zero
false-fires); (3) ship default-OFF first, promote only on CI-significant evidence; (4) attribute as a
harness rescue in reports.
**Acceptance:** each shipped archetype has an A/B showing CI-significant floor movement + a no-false-fire
suite run recorded; default state justified by evidence.
**Docs-to-update:** `docs/architecture.html`, `README.md` (env flags), `docs/harness-engineering-roadmap.md`.
**Result:** _(fill in when done)_

---

## 10. EPIC E5 — Discipline & positioning (P1, cheap, cross-cutting)

### E5-T1 — Mechanism attribution in every run/eval report  ·  P1 · S · Status: ☐ TODO
**Goal:** No output ever implies "the small model solved it" when a rescue or escalation did.
**Files:** `src/cli/commands/run.ts` output, `scripts/run-baseline.ts` table, `scripts/classify-pass-quality.ts`.
**Acceptance:** every solved-run/eval line states the mechanism (model / <rescue> / escalated-to-<model>).
**Docs-to-update:** `README.md`, `docs/architecture.html`.
**Result:** _(fill in when done)_

### E5-T2 — Position the target user + honest limits in docs  ·  P1 · S · Status: ☐ TODO
**Goal:** Stop implying smallcode competes with Cursor. State the real winning use case:
**mechanical, well-scoped, single-file bug fixes in offline / air-gapped / regulated environments where
cloud coding tools are not permitted** — "the only allowed option," plus budget-averse local-only users.
Add an honest "what it can't do" (multi-file, large refactors, hard localization).
**Files:** `README.md` (top), `index.html` (hero + a "who it's for / what it can't do" section).
**Acceptance:** docs name the target user and the honest limits; no claim of general parity with cloud tools.
**Docs-to-update:** `README.md`, `index.html`, `docs/architecture.html` footer.
**Result:** _(fill in when done)_

### E5-T3 — Docs-drift CI check script  ·  P2 · M · Status: ☐ TODO
**Goal:** Enforce the HARD no-drift rule mechanically. A script that fails CI when code changes a
flag/command/number without a matching doc update.
**Files:** new `scripts/check-docs-sync.ts`; wire into `bun run check` / CI.
**Steps:** extract the set of `SMALLCODE_*` env vars and CLI subcommands from source; assert each appears
in `README.md`/`docs/llms.html`; assert `docs/architecture.html` footer date is recent on doc-affecting
diffs. Start advisory (warn), then enforce.
**Acceptance:** removing an env var from docs but not code (or vice-versa) fails the check.
**Docs-to-update:** `README.md` (contributor section), the check is itself the enforcement.
**Result:** _(fill in when done)_

---

## 11. Sequencing summary (do in this order)

1. **E1-T1** (regression-proof the oracle) → **E1-T3** (verified revert) → **E1-T2** (journal/crash
   recovery) → **E1-T4** (fail-closed guard) → **E1-T5** (failure UX) → **E1-T6** (undo test). *M1 done.*
2. **E2-T2** (health check) → **E2-T4** (model validation) → **E2-T3** (auto-pull) → **E2-T1** (doctor)
   → **E2-T5** (bootstrap install) → **E2-T6** (default model). *M2 done.*
3. In parallel once M1 lands: **E5-T1**, **E5-T2** (cheap, high-credibility), then **E3-T1**, **E3-T2**. *M3.*
4. Then **E4-T1** → **E4-T2**, and **E3-T3**, **E5-T3** as capacity allows. *M4.*

**Do NOT** invest in cross-file/multi-file capability, agentic auto-PR, or a cloud-escalation core — the
panel unanimously scored these lowest (capability ceiling is mapped and confirmed; they bet against known
model limits). Revisit only if the localization ceiling demonstrably moves.

---

_Last updated: 2026-07-22. Keep this table's Status column current — it is the single source of truth for
what is left to do._
