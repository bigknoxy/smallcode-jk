# HANDOFF — smallcode

> **Living doc. UPDATE THIS on every meaningful step** (new commit, A/B result, merge, decision). Assume the next agent has NO memory — this file is its only bridge. Keep it terse and CURRENT. Stale handoff = bug.
> Last updated: **2026-07-13**

## What smallcode is
A coding HARNESS that makes a SMALL LOCAL model (qwen2.5-coder 3b/7b/32b via Ollama, fully offline) fix real bugs on real repos. Thesis: **harness design > model size.** Small models can't localize faults or derive non-trivial logic (capability ceiling, proven repeatedly). Wins come from HARNESS-side deterministic rescues + attention-shaping, not model coaxing.

## Current work stream: multi-file capability axis
The harness could not fix bugs spanning >1 file (single `lockedTargetPath`). Three stacked opt-in levers now let it — and let a 7b do it:

| lever | env flag | default | what it does |
|---|---|---|---|
| Target set | `SMALLCODE_TARGET_SET` | **ON** | generalizes single-file lock → bounded editable set (primary + direct import neighbors). Makes both files EDITABLE. |
| Set carousel | `SMALLCODE_SET_CAROUSEL` | **ON** | on model stall, walks model ATTENTION across the set (fresh `## FOCUS THIS TURN` prompt). Harness does the cross-file localization the small model can't. Requires TARGET_SET. No-op on single-file (set length 1). |
| Literal repair | `SMALLCODE_LITERAL_REPAIR` | **OFF (stays)** | last-resort deterministic pass: brute-force integer-literal ±1/±2 over the editable SET, run real oracle, keep first full-green. Cracks off-by-one-CONSTANT bugs (`toFixed(1)→(2)`) operator-mutation can't. **Audit DONE 2026-07-13 (`scripts/audit-literal-repair.ts`): 4/38 FAKE-GREENS → KEEP OFF** (see below). |

All require `SMALLCODE_TARGET_LOCK=1` (default on). TARGET_SET+carousel default ON since 2026-07-09 (regression-neutral, see below); LITERAL_REPAIR opt-in.

## Git state
- Multi-file work MERGED to `main` via PR #130 (commits `8728076`+`efb6c78`+`e3ad581`). CI green.
- Default-on flip: branch **`feat/default-on-targetset-carousel`** (TARGET_SET+carousel defaults OFF→ON, docs synced, one test pinned to `TARGET_SET=0`). Suite 1120/0, tsc clean. Shipping via PR + admin-merge.
- Merge to protected `main` = PR + `gh pr merge <#> --admin --merge`.

## A/B results (7b, task `multifile-receipt_1` — a GENUINE 2-file bug: index.js missing `*qty` + money.js `toFixed(1)` should be `(2)`; fixing either alone stays red)
**Carousel** (TARGET_SET on both arms), pooled **n=40/arm**:
- **ON 0.425 [.29-.58] vs OFF 0.125 [.05-.26]** — non-overlapping Wilson CIs, **Fisher p=0.005**. Turns 13.7→10.6.
- **SIGNIFICANT. Thesis confirmed:** harness elevates 7b past its cross-file localization ceiling.
- Causal (transcripts): every solve fixed the neighbor AFTER carousel moved focus there; zero without. Residual failures = 7b can't derive `toFixed(2)` even handed the file → that's what LITERAL_REPAIR targets.
- 32b: solves 1-turn with TARGET_SET alone (localizes both itself); 7b needs carousel.

**Literal-repair** (carousel+literal n=25 vs carousel-only n=25=0.48): **0.96 [.80-.99] (24/25)**, Fisher **p=0.0003**, non-overlapping CIs. DONE + significant.

**Regression A/B — the default-on gate** (TARGET_SET+carousel ON vs OFF, 22-task realrepo SINGLE-file suite, 7b, n=8, mutation-repair OFF for a conservative measure): pooled **ON 157/176 = 0.892 [.838-.930] = OFF 157/176 = 0.892 [.838-.930]** — IDENTICAL. 20/22 tasks byte-identical; the only two deltas (dequal-object 7→6, tinycalc 0→1) are ±1-trial noise that cancel. Regression-NEUTRAL → flipped TARGET_SET+carousel to default ON. Conservative because mutation-repair (rescue-only, fires both arms) can only make the real config ≥ as safe. NOTE: background eval runs kept getting reaped by the harness mid-run; foreground `SMALLCODE_TASK_FILTER` batches (≤10min each) ran clean — use that pattern for long evals, not `run_in_background`.

### Full-stack ladder (7b, `multifile-receipt_1`) — the headline result
| config | pass@1 |
|---|---|
| bare (all levers off) | 0.16 [.06-.35] |
| + carousel | 0.48 [.30-.67] |
| + carousel + literal-repair | **0.96 [.80-.99]** |
Every step CI-significant on THIS fixture. **Harness took a 7b from 16% → 96% on a real 2-file bug.** But see generality below — the 96% was partly literal-repair-specific and does NOT transfer to every coupling shape.

## GENERALITY RESULT (2026-07-13, PR #132 merged `ee3b84a`) — the 16→96 does NOT cleanly generalize; it REFINES
Added 3 new genuine two-file fixtures with DISTINCT coupling shapes/archetypes (`multifile-taxrate_1` shared-const: wrong-const `0.8`→`0.08` + wrong-operator `-`→`+`; `multifile-slug_1` string-pipeline: missing `.trim()` + wrong join `_`→`-`; `multifile-fullname_1` object-field: missing field `last` + wrong sep `_`→space). All verified genuine-multifile (each single-file fix red, both green) via official dry-run gate (4/4) + independent 4-check script. **NONE is crackable by literal-repair (decimals/strings/methods, not integer literals) or operator-mutation (arithmetic `+/-`, not comparison) — so this A/B ISOLATES the core carousel/target-set mechanism, no deterministic-rescue confound.**

A/B (7b, n=10/arm, TARGET_SET on both arms, literal+operator repair OFF):
| task | coupling | bare (carousel off) | + carousel | read |
|---|---|---|---|---|
| taxrate_1 | shared const | 0.00 | 0.00 | CAPABILITY CEILING — 7b can't derive decimal `0.8→0.08` + operator flip even with attention placed |
| slug_1 | string pipeline | **0.90** [.70-1.0] | 0.90 [.70-1.0] | TARGET_SET ALONE suffices; edits simple → model never stalls → carousel no-op |
| fullname_1 | object field | 0.00 | **0.10** [.00-.30] | model fixates; carousel = marginal nudge (1/10), NOT CI-significant |

**Refined north-star claim (honest):**
- **TARGET_SET (editability of the import-neighbor) is the ROBUST general win** — it carried slug to 0.90 on a brand-new coupling shape with zero other help. Making both files editable is what generalizes.
- **Carousel is a CONDITIONAL stall-rescue**, not a universal lift: no-op when the model solves fast (slug 0.90=0.90), marginal when it fixates on a doable edit (fullname 0→0.10, not sig), useless when edits exceed the model (taxrate 0=0). Receipt was the favorable case (strong 0.16→0.48) because its index.js edit was doable-once-focused AND its neighbor bug was literal-crackable.
- **The 96% headline was LITERAL-REPAIR-specific** (cracking `toFixed(1)→(2)`); it does not transfer to bugs without a brute-forceable literal/operator. Stop citing 16→96 as a general result — cite it as the receipt-fixture ladder, and cite the generality table for the honest cross-shape picture.
- Ceiling persists (taxrate) exactly as [[project_lever_frontier_mapped]] predicts: no model-side lever crosses a genuine derivation ceiling.

## LITERAL_REPAIR FAKE-GREEN AUDIT (2026-07-13) — DONE → keep OFF
Built `scripts/audit-literal-repair.ts` (MODEL-FREE, deterministic; reuses the real `enumerateLiteralMutations` + real deterministic grader). For every solution-backed task in realrepo/edit-reliability/multifile: lay pristine buggy fixture, apply each literal candidate one at a time (worst-case whole-file scope), run the real oracle, classify first green as no-green / true-fix / FAKE-GREEN. Reproduced independently (deterministic, same numbers twice):
| suite | scanned | no-green | true-fix | FAKE-GREEN |
|---|---|---|---|---|
| realrepo | 22 | 21 | 0 | 1 |
| edit-reliability | 12 | 8 | 1 | 3 |
| multifile | 4 | 4 | 0 | 0 |
| **TOTAL** | **38** | **33** | **1** | **4 (10.5%)** |
All 4 fake-greens share ONE shape: a reference fix that REMOVES a `- 1`/`+ 1` term (or changes a boundary operator `<`→`<=`) coincidentally imitated by flipping a nearby `1`→`0`. **fn-range scoping does NOT fix it** — the offending flips sit INSIDE the target function, siblings of the correct fix; the failure is STRUCTURAL (term-removal vs value-substitution), not locality. So "deterministic ⇒ can't fake-green" is FALSE on thin oracles. **Disposition: SMALLCODE_LITERAL_REPAIR stays default OFF.** A real promotion needs a stronger guard (e.g. require the greening flip's position to match a term the model's own diff touched, or a regression check beyond the single failing test). Docs corrected: llms.html had a now-false "can't fake-green" claim (fixed); README + llms module map note the audit.

Also measured (data, not assumption): full existing repair stack (operator-mutation incl `+`↔`-`, + literal, + carousel) on taxrate = **0/10** — confirms single-mutation repair CANNOT crack taxrate (needs both fixes at once; the decimal `0.8` isn't even matched by the integer-only enumerator). And `+`↔`-` ALREADY lives in `operator-mutation.ts` (rank 4) — no separate arith pass needed; only `*`↔`/` would be net-new (low value).

## NEXT STEPS (in order)
1. ~~Ship default-on flip~~ DONE (#131 `d794648`). ~~Generality suite~~ DONE (#132 `ee3b84a`). ~~LITERAL_REPAIR audit~~ DONE (keeps OFF, above).
2. **If pursuing LITERAL_REPAIR promotion:** build the stronger guard (position-match to the model's own attempted diff, or multi-test regression check) that eliminates the 4 fake-greens, re-run `scripts/audit-literal-repair.ts` (target: 0 FAKE-GREEN), THEN promote. Only worth it if a real task needs it.
3. **3b on the multi-file axis** — cheapest remaining measurement (7b already 0 on taxrate/fullname → 3b likely ≤ that; slug 0.90 might survive). Run bare vs carousel on the 4 multifile tasks, n=10, foreground batches.
4. Real-dogfood multi-file (not synthetic): does TARGET_SET help on a genuine 2-file bug in a real repo? The robust general win deserves a real-world confirmation.

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
- No foreground `sleep` in Bash tool (blocked). **`run_in_background` eval runs get REAPED by the harness mid-run (unreliable for multi-hour jobs).** For long evals use FOREGROUND `SMALLCODE_TASK_FILTER` batches (~4-5 tasks, `timeout` 600000ms each) and accumulate per-task `pass@1=` lines from each log — the runner prints them incrementally, so partial results survive. A running run loads loop.ts ONCE at launch (in-process) → editing loop.ts mid-run is safe for it.
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

## Task list (harness tasks)
- Multi-file levers built + A/B'd + MERGED (PR #130): carousel pooled p=0.005; literal-repair 0.96 vs 0.48 p=0.0003; full ladder 16→96%.
- Regression A/B DONE — TARGET_SET+carousel regression-neutral (0.892=0.892) → defaults flipped ON (shipping now).
- OPEN: generality multi-file suite; LITERAL_REPAIR fake-green audit (before its own default-on); 3b on this axis. See NEXT STEPS.
