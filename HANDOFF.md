# HANDOFF — Release automation, distribution & CI initiative

**Status doc for resuming work if the session is interrupted or a fresh agent (no prior context) picks up.** Update the checkboxes as pieces land. Delete this file when the initiative is fully shipped + verified.

Repo: **bigknoxy/smallcode-jk** (public) · Pages: https://bigknoxy.github.io/smallcode-jk/ · CLI name stays `smallcode`.
Working branch: `feat/release-automation` (off `main`). `main` is protected (ruleset: PR + code-owner review, admins bypass). Merge via `gh pr merge <branch> --admin --merge`.

## Goal (user request, verbatim intent)
1. Rename GitHub repo to `smallcode-jk`; CLI stays `smallcode`.
2. **Auto-versioned releases** — releases show up automatically with proper changelog + history, fully automated.
3. **One-line idempotent install**: `curl ... | sh` (re-runnable safely).
4. `smallcode update` and `smallcode uninstall` both work.
5. `smallcode --version` works (currently returns 0.0.0 — package.json has NO version field).
6. **Basic CI** that must be green on `main` and on PRs (wired as a required status check).
7. **VERIFY everything — no assumptions** (actually run install/update/uninstall, see CI go green, see a release created).
8. (Added) Deep-research the GEPA "automatically learning skills for coding agents" blog; assess if leverageable.

## Key decisions / architecture
- **Install mechanism = source/release-tarball requiring Bun.** smallcode's oracle runs `bun test` as a subprocess, so Bun is required at runtime regardless — a compiled binary wouldn't remove that dep. So `install.sh`: detect/require `bun` (+ note `ollama` prereq) → download the **latest GitHub Release tarball** (fall back to `main` tarball if no release yet) into `~/.smallcode` → `bun install` → write a `smallcode` wrapper to `~/.local/bin` (execs `bun ~/.smallcode/bin/smallcode.ts "$@"`). Idempotent (overwrite cleanly).
- **`smallcode update`** = re-fetch latest release into `~/.smallcode` + `bun install`. **`smallcode uninstall`** = remove `~/.smallcode` + the wrapper. Both are CLI subcommands.
- **Versioning = release-please** (Google), driven by Conventional Commits (we already use feat/fix/chore/docs). It maintains a release PR, bumps `package.json` version, generates `CHANGELOG.md`, creates the GitHub Release + tag. Seed `package.json` version `0.1.0` + `.release-please-manifest.json`.
- **`--version`** already reads `package.json` version in `bin/smallcode.ts` (returns 0.0.0 today because the field is missing — adding it fixes this).
- **CI** = `.github/workflows/ci.yml` on push(main)+pull_request → `bun install` → `bunx tsc --noEmit` → `bun test`. Must be green. Then add it as a **required status check** in the `main` ruleset.

## Work breakdown & STATUS
- [x] Rename repo → `smallcode-jk`; update local git remote. (Pages auto-moved.)
- [x] **WT-A install/CLI** — MERGED. `install.sh` (idempotent, `SMALLCODE_TARBALL` override → latest release → main), `smallcode update`/`uninstall`, `package.json` version 0.1.0 → `--version` works. **e2e VERIFIED no-network:** install→`v0.1.0`→update→uninstall(--yes) all exit 0, dirs removed. (Agent stalled mid-test due to a wifi drop; I recovered + verified.)
- [x] **WT-B CI/releases** — MERGED. `.github/workflows/ci.yml` (job `test`: bun install→tsc→bun test), `release-please.yml` + `release-please-config.json` + `.release-please-manifest.json` (0.1.0), `CHANGELOG.md`. Validated YAML/JSON; CI steps green locally.
- [x] Flaky integration test hardened (30s→60s timeouts; was load-induced from concurrent agents, not a CI risk).
- [ ] Mechanical: replace `github.com/bigknoxy/smallcode-claude` → `smallcode-jk` and Pages URL refs across `index.html`, `docs/*.html`, README. (owner: main agent)
- [x] Wire CI as a **required status check** in the `main` ruleset — done (ruleset 18090982 now has a `required_status_checks` rule for context `test`).
- [x] PR #3 (distribution) admin-merged to `main`; CI `test` passed on the PR (39s).
- [x] Security: pinned all GitHub Actions to commit SHAs + added `.github/dependabot.yml` (PR #4). (Automated security review flagged unpinned actions.)
- **GOTCHA (release-please):** the first run FAILED with "GitHub Actions is not permitted to create or approve pull requests." Fix = `gh api -X PUT repos/bigknoxy/smallcode-jk/actions/permissions/workflow -F default_workflow_permissions=write -F can_approve_pull_request_reviews=true` (this repo setting is OFF by default). After fixing, re-run the release-please workflow.
- **NOTE:** release-please computed the first version as **1.0.0** (not 0.1.0) — verify the changelog when its PR opens; adjust via a `Release-As: x.y.z` commit footer or config if the major bump is unwanted.
- [x] GEPA-skills research → `docs/research/gepa-skills.md`. TL;DR: gskill GEPA-evolves a repo-scoped additive `SKILL.md` that transfers across models (Jinja 55→82%, Bleve 24→93%). smallcode is ~80% GEPA-shaped already; concrete next PR = add `PromptSet.skill?` slot + `src/improve/skill-distiller.ts` (mine passing transcripts → seed skill), pure-code/unit-verifiable; GEPA-evolving it is compute-gated. Offline caveat: use a LOCAL stronger reflector (qwen2.5-coder-7b), never cloud. (Future track, not part of this release initiative.)
- [ ] PR `feat/release-automation` → `main`; confirm **CI green on the PR**; admin-merge.
- [ ] After merge: release-please opens its release PR → merge it → first release (v0.1.0) created. Verify the release + CHANGELOG exist.
- [x] **End-to-end VERIFY (no assumptions)** — DONE on the REAL v1.0.0 release path: install → `smallcode v1.0.0` → update (1.0.0→1.0.0) → uninstall (dirs removed), all exit 0.
  - **BUG caught by the live test (override-only test had hidden it):** `install.sh` `log()` wrote to STDOUT, so messages inside `resolve_tarball_url` ("Found latest release…") polluted the `$(...)`-captured tarball URL → only manifested on the GitHub-release path (not the `SMALLCODE_TARBALL` override path). Fix: `log()` → stderr (commit on `fix/install-release-path`). Re-verified live: works.
  - Note: `raw.githubusercontent.com` was DNS-flapping on the test connection; verified by fetching install.sh via `api.github.com` instead — the tarball download itself uses `github.com` (resolves), so the real install path is fully exercised.

## DONE — initiative complete
Repo `smallcode-jk` public + Pages live; `main` protected (PR + code-owner review + required `test` check, admin bypass); one-line installer + update/uninstall + `--version` (verified live); CI green on push+PR; release-please auto-versioning live (**v1.0.0** released with full CHANGELOG); actions SHA-pinned + Dependabot. GEPA-skills research in `docs/research/gepa-skills.md`. _This file can be deleted once the fix PR merges._

## How to resume (fresh agent)
1. `cd /Users/Joshua.Knox/projects/smallcode-claude`; `git fetch`; check `git branch` for `feat/release-automation` and `git worktree list` for `wt/install-cli` + `wt/ci-releases`.
2. Read the STATUS checkboxes above; read sub-agent commits in each worktree (`git -C ../smallcode-wt-rela log`).
3. Verify with the gold-standard bar: `bunx tsc --noEmit` clean + `bun test` green before any merge; nothing merged with failing tests/tsc errors/broken links.
4. Deploy/merge: PR → `gh pr merge --admin --merge`. Pages + releases auto-update on `main`.

_Last updated: 2026-06-24 (initiative kickoff)._
