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
- [ ] **WT-A `wt/install-cli`** (worktree `../smallcode-wt-rela`): `install.sh` (idempotent curl|sh), `smallcode update`/`uninstall` subcommands, verify `--version`, README quickstart one-liner. All refs use `smallcode-jk`. Verify locally in a temp HOME.
- [ ] **WT-B `wt/ci-releases`** (worktree `../smallcode-wt-relb`): `.github/workflows/ci.yml`, release-please workflow + `release-please-config.json` + `.release-please-manifest.json`, add `version` to `package.json`, seed `CHANGELOG.md`.
- [ ] Mechanical: replace `github.com/bigknoxy/smallcode-claude` → `smallcode-jk` and Pages URL refs across `index.html`, `docs/*.html`, README. (owner: main agent)
- [ ] Wire CI as a **required status check** in the `main` ruleset (after CI has run once so the check name is known).
- [ ] GEPA-skills research → findings written to `docs/research/gepa-skills.md` (separate research subagent).
- [ ] PR `feat/release-automation` → `main`; confirm **CI green on the PR**; admin-merge.
- [ ] After merge: release-please opens its release PR → merge it → first release (v0.1.0) created. Verify the release + CHANGELOG exist.
- [ ] **End-to-end VERIFY (no assumptions):** in a clean `HOME`, `curl <raw install.sh> | sh` → `smallcode --version` prints the release version → `smallcode update` works → `smallcode uninstall` removes everything. Record results here.

## How to resume (fresh agent)
1. `cd /Users/Joshua.Knox/projects/smallcode-claude`; `git fetch`; check `git branch` for `feat/release-automation` and `git worktree list` for `wt/install-cli` + `wt/ci-releases`.
2. Read the STATUS checkboxes above; read sub-agent commits in each worktree (`git -C ../smallcode-wt-rela log`).
3. Verify with the gold-standard bar: `bunx tsc --noEmit` clean + `bun test` green before any merge; nothing merged with failing tests/tsc errors/broken links.
4. Deploy/merge: PR → `gh pr merge --admin --merge`. Pages + releases auto-update on `main`.

_Last updated: 2026-06-24 (initiative kickoff)._
