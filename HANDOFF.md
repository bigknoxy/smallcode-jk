# HANDOFF — smallcode

> **Living doc. UPDATE THIS on every meaningful step** (new commit, A/B result, merge, decision). Assume the next agent has NO memory — this file is its only bridge. Keep it terse and CURRENT. Stale handoff = bug.
> Last updated: **2026-07-09**

## What smallcode is
A coding HARNESS that makes a SMALL LOCAL model (qwen2.5-coder 3b/7b/32b via Ollama, fully offline) fix real bugs on real repos. Thesis: **harness design > model size.** Small models can't localize faults or derive non-trivial logic (capability ceiling, proven repeatedly). Wins come from HARNESS-side deterministic rescues + attention-shaping, not model coaxing.

## Current work stream: multi-file capability axis
The harness could not fix bugs spanning >1 file (single `lockedTargetPath`). Three stacked opt-in levers now let it — and let a 7b do it:

| lever | env flag (default OFF) | what it does |
|---|---|---|
| Target set | `SMALLCODE_TARGET_SET` | generalizes single-file lock → bounded editable set (primary + direct import neighbors). Makes both files EDITABLE. |
| Set carousel | `SMALLCODE_SET_CAROUSEL` | on model stall, walks model ATTENTION across the set (fresh `## FOCUS THIS TURN` prompt). Harness does the cross-file localization the small model can't. Requires TARGET_SET. |
| Literal repair | `SMALLCODE_LITERAL_REPAIR` | last-resort deterministic pass: brute-force integer-literal ±1/±2 over the editable SET, run real oracle, keep first full-green. Cracks off-by-one-CONSTANT bugs (`toFixed(1)→(2)`) operator-mutation can't. |

All require `SMALLCODE_TARGET_LOCK=1` (default on). All opt-in, default OFF.

## Git state
- Branch: **`feat/multifile-target-set`** (NOT merged to protected `main`).
- Commits (3): `8728076` (TARGET_SET) + `efb6c78` (SET_CAROUSEL) + HEAD (LITERAL_REPAIR, `git log -1`). All include synced docs.
- Working tree CLEAN. Nothing uncommitted.
- Merge to `main` is gated: user must type literal **`merge NNN`**. Do NOT push/merge without it. Deploy = PR + admin-merge. **Branch is READY to merge on user's word.**

## A/B results (7b, task `multifile-receipt_1` — a GENUINE 2-file bug: index.js missing `*qty` + money.js `toFixed(1)` should be `(2)`; fixing either alone stays red)
**Carousel** (TARGET_SET on both arms), pooled **n=40/arm**:
- **ON 0.425 [.29-.58] vs OFF 0.125 [.05-.26]** — non-overlapping Wilson CIs, **Fisher p=0.005**. Turns 13.7→10.6.
- **SIGNIFICANT. Thesis confirmed:** harness elevates 7b past its cross-file localization ceiling.
- Causal (transcripts): every solve fixed the neighbor AFTER carousel moved focus there; zero without. Residual failures = 7b can't derive `toFixed(2)` even handed the file → that's what LITERAL_REPAIR targets.
- 32b: solves 1-turn with TARGET_SET alone (localizes both itself); 7b needs carousel.

**Literal-repair** (carousel+literal n=25 vs carousel-only n=25=0.48): **0.96 [.80-.99] (24/25)**, Fisher **p=0.0003**, non-overlapping CIs. DONE + significant.

### Full-stack ladder (7b, `multifile-receipt_1`) — the headline result
| config | pass@1 |
|---|---|
| bare (all levers off) | 0.16 [.06-.35] |
| + carousel | 0.48 [.30-.67] |
| + carousel + literal-repair | **0.96 [.80-.99]** |
Every step CI-significant. **Harness took a 7b from 16% → 96% on a real 2-file bug.** North-star proof: harness > model size.

## NEXT STEPS (in order)
1. **Await user `merge`** (branch = 3 commits, tree clean, all A/Bs done + significant). Do NOT merge unprompted. On `merge`: push branch → open PR → admin-merge to `main`.
2. Open follow-ons (NOT started, lower priority): (a) regression A/B that these levers ON don't hurt the single-file realrepo suite before any default-on flip; (b) GENERALITY — add more genuine multi-file tasks to `evals/suites/multifile` (currently ONE fixture; a single task can't prove the levers generalize beyond it — this is the main open risk to the result); (c) 3b never tested on this axis (7b is the floor that works; 3b likely below localization ceiling even with carousel).

## Run an A/B (exact)
```
SCRATCH=/private/tmp/claude-501/-Users-Joshua-Knox-projects-smallcode-claude/4aed2d2d-9c76-4f35-adfb-92e651df582e/scratchpad
SMALLCODE_SUITE=multifile SMALLCODE_MODEL=qwen2.5-coder:7b SMALLCODE_TARGET_LOCK=1 \
  SMALLCODE_TARGET_SET=1 SMALLCODE_SET_CAROUSEL=1 SMALLCODE_LITERAL_REPAIR=1 \
  SMALLCODE_EVAL_N=25 SMALLCODE_EVAL_MAX_TURNS=15 SMALLCODE_WATCHDOG=0 \
  bun scripts/run-baseline.ts > "$SCRATCH/OUT.log" 2>&1
```
Toggle flags 0/1 for arms. Dry-run (no model, checks fixture+solution): add `SMALLCODE_DRY_RUN=1`. Causal audit: `SMALLCODE_SAVE_TRANSCRIPTS=1` → `evals/transcripts/multifile-receipt_1/` (dir HARDCODED; clean before commit). Read table: `grep "multifile-receipt_1 " OUT.log`. Significant ⟺ non-overlapping Wilson CIs OR Fisher p<0.05 (write a `bun -e` inline stats script: Wilson + Fisher-exact 2-tailed).

## GOTCHAS (each cost real time)
- **zsh**: unquoted `$VAR` does NOT word-split. Inline env vars in the command; do NOT build `BASE="A=1 B=2"` and expand (becomes ONE arg → wrong suite name).
- `run-baseline.ts` APPENDS to `evals/metrics-history.jsonl` every run (incl dry-run). `git checkout` it before commit.
- `evals/transcripts/` = untracked spew → `rm -rf` before commit.
- No foreground `sleep` in Bash tool (blocked). Use `run_in_background`; harness notifies on completion. A running A/B loaded loop.ts ONCE at launch (in-process) → editing loop.ts mid-run is safe for it.
- **Bun** not node/npm: `bun test`, `bunx tsc --noEmit`.
- Delegate to cheap subagents (haiku/Explore = mapping, sonnet = build) to save tokens.
- User session: CAVEMAN MODE (terse) on; write code/commits/docs normally. Web = gstack `/browse`, never `mcp__claude-in-chrome`.

## Key files
- `src/agent/target-set.ts` — `computeEditableSet`, `pinNeighborsIntoContext`.
- `src/agent/carousel.ts` — pure `advanceCarousel(state, editablePaths, opts)`.
- `src/repair/literal-mutation.ts` — pure `enumerateLiteralMutations`; reuses `scopeMutationsToRange` from `operator-mutation.ts`.
- `src/repair/operator-mutation.ts`, `src/repair/read-after-delete.ts` — sibling deterministic rescues (mirror their structure).
- `src/agent/loop.ts` — turn loop. Carousel hook ~L1150/1229; repair call sites ~L1416 (operator), ~L1589 (literal), ~L1469 (statement); `runLiteralRepair` def ~L473 (iterates `state.editablePaths`).
- `src/config/env.ts` — `env` getters + `ENV_REGISTRY` (authoritative flag inventory; count test `tests/config-env.test.ts`, currently **23**).
- `src/verify/oracle.ts` — `runTieredOracle`; full-green ⟺ `verdict.outcome==="solved"`.
- `evals/suites/multifile/` + `evals/fixtures/multifile-receipt_1/` — the genuine 2-file task.
- Docs (MANDATORY sync per CLAUDE.md — never drift): `README.md`, `index.html`, `docs/llms.html`, `docs/architecture.html` (footer = today).

## Task list (harness tasks) — ALL DONE
- #46 Map loop machinery — DONE
- #47 Build carousel — DONE (efb6c78)
- #49 n=25 significance A/B — DONE (carousel pooled p=0.005, significant)
- #50 Build + A/B literal-repair — DONE (0.96 vs 0.48, p=0.0003, committed)
- Only open item: user `merge` decision + the generality follow-ons above.
