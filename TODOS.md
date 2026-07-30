# TODOS — deferred scope

Things deliberately NOT being done right now, with the reason and the trigger that would
un-defer them. Active work lives in [docs/PRODUCTION_BACKLOG.md](docs/PRODUCTION_BACKLOG.md);
this file is only for what we chose to skip.

---

## Deferred — decided 2026-07-30 (E6 planning)

### 1. npm publish / installable distribution
`package.json` has `"private": true`, so smallcode has **zero installable users** — the only way
to run it is `git clone`. The strategy review ranked flipping this above E6 on leverage, since
E6's benefit today accrues entirely to an n=1 maintainer dogfood loop.

- **Effort:** hours. Flip `private`, verify the `bin` block resolves, write an install path,
  smoke-test `bunx smallcode --help` from a clean directory.
- **Why deferred:** owner chose to land the oracle-cost epic first.
- **Trigger to un-defer:** any external interest, or E6 completing.

### 2. Subset / targeted test selection — REJECTED, not merely deferred
Do not build this. Reviewed and killed on a verified argument: *static reachability is evidence of
inclusion, never proof of exclusion.* A reverse import graph cannot prove a Bun test is unable to
observe an edit (subprocess-spawning tests, fixture reads, codegen, `exports` aliasing, preload
files, global state, `bunfig.toml` edits). A subset verdict with fewer reds reads
`regressed = false`, so the per-turn revert **keeps a regression it cannot see** — the same shape
as the 4000-char truncated-`redCount` bug and the `SMALLCODE_*` env-poison bug.

- **Trigger to un-defer:** a mechanism that can *prove* exclusion. A better import graph is not
  that mechanism.
- Full write-up: `docs/PRODUCTION_BACKLOG.md` §11, "The rejected design."

### 3. Multi-process sharding of the full test run
Splitting the 1250-test suite across processes. Effort M-L, risk Med-High: must preserve full test
discovery and aggregate failures/load-errors exactly, avoid CPU oversubscription, and handle
setup/ordering/isolation differences.

- **Why deferred:** E6's cache removes redundant runs entirely, which is strictly safer. Measure
  first (E6-T1), then see whether a gap remains.
- **Trigger to un-defer:** E6-T1's before-number and E6-T5's after-number leave a material gap.

### 4. Cross-file / multi-file capability levers
Bidirectional editable set (the known forward-import-only hole in `src/agent/target-set.ts`),
coupled-declaration handling, agentic auto-PR, cloud-escalation core.

- **Why deferred:** standing decision from the expert panel — see `docs/PRODUCTION_BACKLOG.md`
  §12. They bet against known model limits; the localization ceiling is mapped and confirmed.
- **Trigger to un-defer:** the localization ceiling demonstrably moves.

### 5. Persisting the oracle cache across processes
E6-T3 scopes the memo to a single run. A disk-backed cache would also help repeated eval sweeps.

- **Why deferred:** persistence multiplies the stale-verdict blast radius, and a stale green is a
  false solve. In-process first; prove the fingerprint is sound before trusting it across runs.
- **Trigger to un-defer:** E6-T4's adversarial suite green and E6-T5 promoted to default-ON.
