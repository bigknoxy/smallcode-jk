# Can smallcode leverage gskill ("Automatically Learning Skills for Coding Agents")?

**Source post:** <https://gepa-ai.github.io/gepa/blog/2026/02/18/automatically-learning-skills-for-coding-agents/>
(Shangyin Tan, Lakshya A Agrawal, et al., 2026-02-18)
**GEPA project / API:** <https://gepa-ai.github.io/gepa/> · repo `gepa-ai/gepa`
**Companion tooling cited:** SWE-smith (verifiable-task generator), Mini-SWE-Agent, Claude Code.

Researched 2026-06-24. Self-contained; quotes the numbers verbatim.

---

## TL;DR

- **gskill** = an automated pipeline that, *given a GitHub repo*, learns a repository-specific
  **skill file** (`.claude/skills/{repo}/SKILL.md`) — a chunk of plain-text guidance ("run `go test
  ./...` first, narrow with `-run TestName`, make minimal reviewable changes…") that is **injected
  into the agent's context** at inference.
- The skill text is **evolved by GEPA's `optimize_anything`**: start from an empty/seed skill, run
  the agent on auto-generated verifiable tasks (from **SWE-smith**), feed the *scores + execution
  traces* to a **stronger reflection LLM** that rewrites the skill, keep non-dominated candidates on
  a **Pareto front**, repeat to convergence (~300 rollouts in the paper).
- Reported lift on a held-out test set: **Jinja 55%→82%**, **Bleve 24%→93%** resolve rate
  (Mini-SWE-Agent + gpt-5-mini). Skills **transfer** unchanged to Claude Code: **Bleve Haiku 4.5
  79.3%→100%** (and faster), **Jinja Haiku 4.5 93.9%→98.5%**; Sonnet 4.5 saturated on pass rate but
  ran faster.
- **smallcode already has ~80% of the machinery**: a GEPA engine (`runGepa`), a Pareto front with
  the exact GEPA weighting scheme, a reflective-mutator *interface*, an eval/grader harness that
  returns per-task pass\@1, transcript logging, and a **prompt-as-variable seam** (`PromptSet`).
- **The genuinely new idea worth importing is the artifact being optimized.** smallcode's scaffold
  evolves the *system/planner/reflection prompts*; gskill evolves a *separate, repo-scoped skill
  document* that is **additive context**, not a replacement prompt. That reframing is cheap to adopt
  and a better fit for the north star (real repos, offline).
- **Honest verdict:** Adopt the *concept and data plumbing* now (mine winning transcripts into an
  injectable `SKILL.md`-style block via the existing prompt seam; add a `skill` slot to `PromptSet`).
  The *full GEPA-evolved skill library* is compute-gated (hundreds of 3B Ollama rollouts) — defer
  the marathon, but the pure-code scaffolding and a tiny unit-verifiable first experiment are
  buildable today.

---

## 1. What the blog/method actually is

### 1.1 What a "skill" is here

A **skill is a textual artifact** — concretely a file at `.claude/skills/{repo_name}/SKILL.md` —
that encodes *repository-specific operating guidance* for a coding agent. It is **not** code, not a
tool, and not a fine-tune. It is prose/checklist context that the agent reads alongside the task.

Verbatim example of a learned Bleve skill (Go repo):

> 4) Run tests early and iterate from failures (tests are the bug report)
> - Start broad when feasible: `cd /testbed && go test ./...` (or project equivalent).
> - Narrow quickly:
>   - package: `go test ./path/to/pkg`
>   - single test: `go test ./path/to/pkg -run TestName -count=1` (add -v only if needed)
> - For panics: follow the stack trace top frame in repo code first.
> - For mismatches: use "expected vs got" to locate the producing function and invariants.
>
> 7) Make minimal, reviewable changes and verify continuously
> - Change one behavior at a time; rerun the smallest reproducing test after each change.
> - Add focused unit tests when coverage is missing; keep them in the same package and table-driven…
> - Avoid scratch main.go files in repo root.

The authors explicitly flag a limitation: *"some of these skills are more helpful for SWE-smith
style tasks (fixing issues) instead of general coding practices"* — i.e. the learned content is
biased toward the shape of the training tasks, and broader skills *"can be learned with a more
diverse set of tasks."*

### 1.2 How a skill is learned (the recipe)

gskill = **two components**:

1. **SWE-smith** — *"a data generation pipeline that creates arbitrary verifiable tasks for any
   GitHub repository."* It turns a static repo into *"an active training environment"*: a diverse
   set of issue-style tasks, each grounded in the real codebase and shipping with **verifiable
   tests**. This is the feedback source — *"Learning skills requires feedback, and feedback requires
   tasks."*
2. **GEPA's `optimize_anything`** — the optimization backbone. The loop, verbatim:

   > the `optimize_anything` loop starts with a (possibly empty) set of skills, evaluates the agent
   > with a chosen skill, and then updates the skill by employing **another more powerful LLM to
   > reflect on the evaluation results and feedback**. This process is repeated until convergence.

   GEPA itself (project home page) *"diagnose[s] failures through execution traces rather than
   collapsing outcomes into single scalar rewards,"* claiming *"frontier performance, up to 90x
   cheaper"* than RL. The evaluator returns an `EvaluationBatch` of **scores + trajectories** (full
   traces: inputs, outputs, intermediate steps, errors — the "actionable side information"), and a
   separate **`reflection_lm`** reads those traces and proposes targeted text mutations. Candidates
   live on a **Pareto pool/front**; selection samples per-task "specialist" winners (the same scheme
   smallcode already implements — see §2).

   Minimal API shape (from GEPA docs):
   ```python
   from gepa import optimize
   result = optimize(
       seed_candidate={'prompt_key': 'initial_prompt'},  # here: the seed SKILL.md text
       trainset=training_data, valset=validation_data,
       adapter=your_adapter, task_lm="openai/gpt-4.1-mini",
       max_metric_calls=150)
   ```

### 1.3 How a skill is reused

The learned skill is *"used by any coding agent"* simply by **dropping the `SKILL.md` file into the
agent's environment** (`.claude/skills/{repo}/SKILL.md` for Claude Code). No retraining, no weight
changes — it is **additive context** at inference time. The headline finding is that this artifact
**transfers across models and harnesses**: learned on Mini-SWE-Agent + gpt-5-mini, it lifts Claude
Haiku/Sonnet unchanged.

### 1.4 Datasets, benchmarks, results (exact numbers)

Setup: two repos — **jinja** (Python) and **bleve** (Go). *"~300 SWE-smith tasks per repository,"*
split *train (~200), validation (~50), test (~60)*. Optimization ran *"Under 300 rollouts."*

**Mini-SWE-Agent + gpt-5-mini (resolve rate, held-out test):**

| Repo  | Baseline | With learned skills |
|-------|----------|---------------------|
| Jinja | 55%      | **82%**             |
| Bleve | 24%      | **93%**             |

**Transfer to Claude Code (same tasks; pass rate + avg duration):**

| Repo / model              | Pass rate            | Duration       |
|---------------------------|----------------------|----------------|
| Bleve · Haiku 4.5         | 79.3% → **98.3–100%**| 173s → 142s    |
| Bleve · Sonnet 4.5        | 94.8% → **100%**     | 285s → 169s    |
| Jinja · Haiku 4.5         | 93.9% → **98.5–100%**| 177s → 148s    |
| Jinja · Sonnet 4.5        | ~100% (saturated)    | 254s → 225s    |

(The post's prose and its result tables differ slightly on the Bleve/Jinja Haiku endpoints — 98.3%
vs 100%, 98.5% vs 100% — because prose and figure cite the two repos' best/representative runs; both
ranges are reproduced above.) Key qualitative takeaways the authors stress: large gains on a *weak*
agent/model, **cross-model + cross-harness transfer**, and **wall-clock speedups** even when accuracy
saturates (the skill makes a strong agent more *direct*, not just more correct).

---

## 2. How it relates to what smallcode already has

smallcode already contains a **GEPA-shaped prompt-optimization scaffold**. The mapping is near
one-to-one — the table shows that gskill is mostly a *reframing + data-mining layer* on top of
machinery smallcode has already built.

| gskill concept | smallcode equivalent (file) | Status |
|----------------|------------------------------|--------|
| `optimize_anything` evolution loop | `runGepa()` — `src/improve/gepa/engine.ts` | **Built** (drives select→reflect→score→Pareto-add for `maxGenerations`). |
| Pareto pool + GEPA per-task-winner selection | `ParetoFront` — `src/improve/gepa/pareto-front.ts` | **Built**, including the exact "weight = #tasks this candidate leads" sampling scheme. |
| Reflection LLM that rewrites the artifact from traces | `ReflectiveMutator` interface — `src/improve/gepa/mutator.ts` | **Interface only.** Only `MockMutator` exists; *"No live LLM mutator is implemented here."* |
| Evaluator returning score **+ trajectory** | `evaluateCandidate` / `runTask` → `TaskEvalResult.passAt1` + `Transcript` — `src/improve/gepa/evaluate-adapter.ts`, `src/eval/types.ts` | **Built.** Engine already re-runs failed tasks to collect transcripts and passes them to the mutator as `FailedInstance[]`. |
| SWE-smith verifiable tasks (training data) | Eval suite: capability **cap-\*** tasks (E0–E5) + HumanEval; `deterministic_tests`/`static_analysis`/`llm_rubric` graders — `evals/suites/`, `src/eval/` | **Partial.** smallcode has a curated, hand-built suite (~25 capability fixtures) but **no auto-task-generator** for arbitrary repos. This is the biggest gap vs gskill. |
| `SKILL.md` artifact (additive repo context) | **— (does not exist)** | **Missing concept.** smallcode evolves the *prompts themselves* via `PromptSet {system, planner, reflection}`, not a separate skill doc. |
| Skill file injected into agent context | Prompt seam: `buildSystemPrompt` returns `promptSet.system`; `buildTurnPrompt` appends `## Relevant Context` — `src/agent/prompt.ts`, `src/agent/prompt-set.ts` | **Seam exists**, but injects whole-prompt variants, not an additive skill block. |
| Mining successful/failed runs into reusable knowledge | `SessionLogger` (JSONL of every run + transcript path, `getFailedSessions()`), `task-extractor.ts` (failed session → new `CandidateTask`), `promoter.ts`, `regression-gate.ts` | **Built for tasks, not skills.** The plumbing to harvest transcripts exists; today it mines *new test tasks*, not *skills*. |

**Overlap:** the optimization algorithm (Pareto + reflective mutation + per-task score vector),
transcript collection, the eval/grader oracle, and the prompt-injection seam. smallcode is genuinely
GEPA-shaped already.

**What's new in gskill:**
1. **The artifact = an additive, repo-scoped `SKILL.md`**, distinct from the agent's base prompts.
   This is conceptually cleaner than mutating `system`/`planner` directly: a skill block can be
   added/removed/swapped per repo without risk of corrupting the core harness prompt, and it is
   exactly the unit that *transferred across models* in the paper.
2. **SWE-smith-style automatic task generation** from any GitHub repo — converting a real repo into
   verifiable train/val/test tasks. smallcode has none of this; its tasks are hand-authored.
3. The empirical lesson that **skills transfer across models/harnesses** and **reduce latency**, not
   just error — directly relevant to a slow 3B-on-Ollama setup where turn-count/latency matters.

---

## 3. Can smallcode leverage it? Honest assessment

Yes — but selectively. Split into "pure-code, buildable now" vs "compute-gated" and rank by
(value-to-north-star × buildability on a single-GPU local rig).

### Ranked opportunities

**① Add an additive `skill` slot to `PromptSet` and inject it through the existing seam.**
*Value: high. Buildability: trivial. Compute: none.*
Extend `PromptSet` with an optional `skill?: string` and have `buildSystemPrompt`/`buildTurnPrompt`
append it as a `## SKILL` block (mirroring `## Relevant Context`). This makes a skill a
first-class, A/B-testable, per-repo artifact — the unit gskill showed transfers and speeds up runs.
Everything downstream (eval harness, regression gate) measures its effect for free. **Pure code,
unit-testable today.** This is the keystone; do it first.

**② Mine winning transcripts into a seed skill (transcript → playbook), inject via ①.**
*Value: high. Buildability: medium. Compute: low (offline, no Ollama marathon).*
smallcode already logs every session (`SessionLogger`) with transcript paths and has
`getFailedSessions()`. Add a `getPassedSessions()` + a small extractor that distills *passing*
transcripts on a given repo/suite into a checklist skill (which tools/commands the model used right,
which edit-format it used, how it recovered from a stall). Two flavours:
  - **Cheap/offline:** template-based or local-summarizer distillation of the common successful
    tool sequence (no GEPA loop). Can run on cached transcripts with **zero new Ollama rollouts**.
  - **Better:** use the *stronger reflection model* (gskill's recipe) to write the skill — but note
    the offline constraint (§3, transfer caveats) before reaching for a cloud model.

**③ GEPA-evolve the skill (point `runGepa` at the `skill` slot instead of `system`).**
*Value: high. Buildability: medium (code) but **compute-gated**.*
The engine, Pareto front, and adapter already exist. The only missing code piece is a **live
`ReflectiveMutator`** that calls a model with `(parent skill, failed transcripts)` → new skill text
(replacing `MockMutator`). That mutator is ~50 lines. **But** the *run* is the expensive part:
gskill used ~300 rollouts; on a 3B Ollama model with `bestOfN≥3` and the KV-frag slowdown noted in
project memory, that's a long marathon. **Code now, run later / overnight, in small budgets.**
Start with `maxGenerations=3`, the existing ~25-task capability suite, and `trialsPerTask=1` (already
the `gepa-smoke.ts` config) to validate the loop end-to-end before scaling.

**④ Auto-generate verifiable tasks from a real repo (SWE-smith analogue).**
*Value: very high to north star, but Buildability: hard. Compute: high.*
This is the part that makes the method work on *real repos* (the north star). SWE-smith is the
hard, generative half. smallcode could approximate it later (e.g. mutate a function + its passing
test → fail-to-pass task, using the existing `deterministic_tests` grader contract). Big effort;
defer until ①–③ prove value. Pure-code-ish for task *mutation*, but generating *diverse* tasks well
is the open research problem.

### What is compute-gated vs pure code

- **Pure code (no Ollama marathon):** ① skill slot + injection; the `getPassedSessions` miner and a
  deterministic/template distiller (②, cheap flavour); the live mutator *class* (③ code); unit tests
  for all of the above against `MockMutator` and fixed transcripts.
- **Compute-gated:** any *actual* GEPA evolution run (③), any large skill-vs-baseline A/B on the 3B
  model, and ④'s task generation + validation. These need real rollouts.

### What might NOT transfer to a 3B local / offline model

- **Reflection model quality.** gskill's gains lean on *"another more powerful LLM"* doing the
  reflection (gpt-5-mini was the *task* model; the reflector is stronger). **Offline/north-star
  means no cloud reflector.** Options: (a) use a larger *local* model (e.g. the configured
  `qwen2.5-coder-7b`) as the reflector while VibeThinker-3B stays the task model — legitimate and
  offline; (b) accept weaker, template/heuristic distillation. Do **not** silently wire in a cloud
  model — it violates the fully-local/offline north star. Flag this in any implementation.
- **Context budget & instruction-following.** A 3B model follows long additive context worse than
  Haiku/Sonnet. A verbose `SKILL.md` may *hurt* — keep skills short, imperative, and **measure**
  pass\@1 *and* turn-count via the eval harness, with the regression gate guarding against drift.
- **Skill specificity.** The authors warn learned skills are biased toward SWE-smith *issue-fixing*
  tasks. smallcode's capability suite is small from-scratch/bug-fix tasks — a skill mined there may
  overfit to that shape and not generalize to real-repo work. Mitigate with task diversity (④) before
  trusting a learned skill broadly.
- **Saturation.** On smallcode's easiest cap-\* tasks (already near-ceiling), a skill shows nothing;
  measure on the harder E-tier / HumanEval slices where headroom exists.

---

## 4. Concrete next step (small, buildable, unit-verifiable — no Ollama marathon)

**Experiment: "Additive skill slot + deterministic distiller," proven against fixtures.**

A single small PR, all unit-testable, zero new rollouts:

1. **`PromptSet.skill?: string`** (`src/agent/prompt-set.ts`). Default `undefined`/empty (so
   `defaultPromptSet()` stays byte-identical — preserves the existing seam invariant).
2. **Inject it** in `src/agent/prompt.ts`: if `ps.skill` is non-empty, append a
   `\n\n## SKILL\n${ps.skill}` block to the system prompt (and/or after `## Relevant Context` in
   `buildTurnPrompt`). Mirror the existing append pattern.
3. **`distillSkillFromSessions(passed: SessionLogEntry[], states: AgentState[]): string`** in a new
   `src/improve/skill-distiller.ts`. Deterministic, **no model call**: aggregate the most common
   successful tool sequence + edit-format choice + "ran tests before finish" signal across *passing*
   transcripts into a short imperative checklist (a smallcode-flavoured `SKILL.md`). Add the dual
   `SessionLogger.getPassedSessions()` next to the existing `getFailedSessions()`.
4. **Unit tests** (`bun test`): (a) `defaultPromptSet()` unchanged when `skill` unset;
   (b) non-empty `skill` produces a system prompt containing `## SKILL` and the text;
   (c) `distillSkillFromSessions` over 2–3 canned `AgentState`/transcript fixtures yields a stable,
   non-empty checklist mentioning `run_tests`. No Ollama needed.

**How it plugs in:** ① and ③ make the `skill` field a drop-in optimization target — point the
**already-built** `runGepa` at `skill` instead of `system` later, swapping `MockMutator` for a live
local-model mutator when compute is available. The eval harness (`runTask`/`evaluateCandidate`),
Pareto front, transcript logging, and regression gate all already consume `PromptSet`, so the new
slot is measured for free. Follow-up (separate session, off the critical path): run `gepa-smoke.ts`
config (`maxGenerations=3, populationCap=5, trialsPerTask=1`) over the capability suite with a live
**local** reflector to validate an end-to-end skill-evolution loop before any longer run.

---

## Ranked recommendation

1. **Build ① + the deterministic distiller (②-cheap) now** — the §4 PR. Pure code, unit-verifiable,
   no rollouts, and it establishes the *skill artifact* as a first-class, measurable, transferable
   unit. Highest value-per-effort; unblocks everything else.
2. **Add the live `ReflectiveMutator` class (③-code)** next — small, testable against `MockMutator`
   parity, no run required. Wire it to a *local* reflector (qwen-7b), never a cloud model, to honour
   the offline north star.
3. **Run a tiny GEPA skill-evolution smoke (③-run)** in a dedicated compute budget once 1–2 land —
   start at the existing `gepa-smoke.ts` scale, measure pass\@1 *and* turn-count on the harder
   E-tier/HumanEval slices.
4. **Defer the SWE-smith analogue (④)** — highest north-star value (real repos) but the hardest and
   most compute-heavy; only pursue after a learned skill demonstrably helps the 3B model on the
   existing suite.

**Bottom line:** smallcode doesn't need to import gskill's code — it already *is* GEPA-shaped. What
it should import is gskill's **idea**: optimize an additive, repo-scoped *skill document* (not the
core prompt), mined from its own transcript logs and injected through the existing seam. The first
step is small, fully offline, and unit-verifiable; the expensive evolution run is optional and
deferrable.
