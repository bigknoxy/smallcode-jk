# Changelog

## [1.11.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.10.0...v1.11.0) (2026-07-14)


### Features

* **context:** semantic retrieval — local-embedding fusion crosses the lexical ceiling ([d429b7b](https://github.com/bigknoxy/smallcode-jk/commit/d429b7b01c13f589014ddb83915cd0e767dddd7c))
* **context:** semantic retrieval — local-embedding fusion crosses the lexical ceiling ([e5f83b5](https://github.com/bigknoxy/smallcode-jk/commit/e5f83b5bfc69957372eab34a72eb6268682481d5))

## [1.10.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.9.0...v1.10.0) (2026-07-13)


### Features

* **agent:** multi-file target set — bounded editable neighborhood unlocks coupled fixes (SMALLCODE_TARGET_SET) ([8728076](https://github.com/bigknoxy/smallcode-jk/commit/8728076cf4812c815f442e1c9ebd33eb7afaeab9))
* **agent:** set-carousel — walk model attention across the editable set so a 7b can solve multi-file bugs (SMALLCODE_SET_CAROUSEL) ([efb6c78](https://github.com/bigknoxy/smallcode-jk/commit/efb6c787e66f2403c9396f13cb48328b2ecb1cd4))
* **config:** default SMALLCODE_TARGET_SET + SMALLCODE_SET_CAROUSEL ON — regression-neutral on single-file, unlocks multi-file by default ([cfaad65](https://github.com/bigknoxy/smallcode-jk/commit/cfaad65f8282f05c806bd1145ff0ee83adc6914c))
* **config:** default TARGET_SET + SET_CAROUSEL ON (regression-neutral, unlocks multi-file by default) ([d794648](https://github.com/bigknoxy/smallcode-jk/commit/d794648165cf87e8163ae6f3a7acbf9bc40fda84))
* **context:** defines-over-uses scorer signal + real-repo localization measuring stick ([0b87a26](https://github.com/bigknoxy/smallcode-jk/commit/0b87a263582fb26c666b7a8fefd74fa04d9ee03e))
* **context:** R2 defines-over-uses scorer signal + real-repo localization measuring stick ([828fa74](https://github.com/bigknoxy/smallcode-jk/commit/828fa74837d6e54debe362a0605625002b47bbeb))
* multi-file capability — target-set + carousel + literal-repair take a 7b 16%→96% on a real 2-file bug ([9f26579](https://github.com/bigknoxy/smallcode-jk/commit/9f26579566fc4a4060c86812a1a26c6d0f9fc48c))
* **repair:** literal-mutation repair — brute-force off-by-one constants across the editable set; 7b hits 96% on a real 2-file bug (SMALLCODE_LITERAL_REPAIR) ([e3ad581](https://github.com/bigknoxy/smallcode-jk/commit/e3ad5818cfa81052d016c47d227f17ce2043287d))


### Bug Fixes

* **agent:** contain repair-pass oracle throws so the final-state guard always runs ([#127](https://github.com/bigknoxy/smallcode-jk/issues/127)) ([a6f68cc](https://github.com/bigknoxy/smallcode-jk/commit/a6f68cc4cebfe842721010addb9067726ea0e0e0))
* **cli:** boolean flags (--json/--yes) must not swallow the next positional ([#126](https://github.com/bigknoxy/smallcode-jk/issues/126)) ([e71e416](https://github.com/bigknoxy/smallcode-jk/commit/e71e41697088f2f66843a9122574b3a223df6d23))
* **context:** pin tie-break stays a TRUE tie-break — never demote path-named winner ([#123](https://github.com/bigknoxy/smallcode-jk/issues/123)) ([1e61881](https://github.com/bigknoxy/smallcode-jk/commit/1e6188119f3d4b2aa47afcfbeb4333424483b3f1))
* **provider:** watchdog abstains on large prompts — prefill-dominated wall-clock tps caused false reload-loops at 32K num_ctx ([#129](https://github.com/bigknoxy/smallcode-jk/issues/129)) ([55e1763](https://github.com/bigknoxy/smallcode-jk/commit/55e1763d28296a1822aa3beb1e16698b7995ce8a))
* **repair:** scope to target fn + gate to assertion reds + fix range-less no-op ([#125](https://github.com/bigknoxy/smallcode-jk/issues/125)) ([06545f9](https://github.com/bigknoxy/smallcode-jk/commit/06545f984e4e8021a497bb4bbe5fbe3832191802))

## [1.9.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.8.0...v1.9.0) (2026-07-05)


### Features

* **config:** default-on for final-state guard + import gate (validated) ([#121](https://github.com/bigknoxy/smallcode-jk/issues/121)) ([43afe08](https://github.com/bigknoxy/smallcode-jk/commit/43afe0831245edd346c4b3666cdc03a091479006))
* **repair:** final-state regression guard — never leave the repo worse than found (opt-in) ([#118](https://github.com/bigknoxy/smallcode-jk/issues/118)) ([2895fe9](https://github.com/bigknoxy/smallcode-jk/commit/2895fe98c5a7667e90223ab8d83bed15a088f2b8))
* **verify:** static import-resolution gate — kill hallucinated imports before they cost a turn (opt-in) ([#119](https://github.com/bigknoxy/smallcode-jk/issues/119)) ([5894ac3](https://github.com/bigknoxy/smallcode-jk/commit/5894ac37dea5509f4d63eb6305afc203bb159632))

## [1.8.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.7.0...v1.8.0) (2026-07-04)


### Features

* **repair:** default SMALLCODE_RAD_HINT on — read-after-delete hint validated suite-wide ([#116](https://github.com/bigknoxy/smallcode-jk/issues/116)) ([20d7144](https://github.com/bigknoxy/smallcode-jk/commit/20d71442bbcc2c6340fae239eeefabe7c93452f6))

## [1.7.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.6.0...v1.7.0) (2026-07-04)


### Features

* **agent:** phase-gated tool access (P0[#2](https://github.com/bigknoxy/smallcode-jk/issues/2), opt-in SMALLCODE_PHASE_GATE, default off) ([#96](https://github.com/bigknoxy/smallcode-jk/issues/96)) ([f4b69e9](https://github.com/bigknoxy/smallcode-jk/commit/f4b69e9ba80d0506df7caa7543bd5ae3751cf2d5))
* **agent:** R2 upper-bound probe — SMALLCODE_R2_FORCE_LINE; proves localization moves the mri floor ([#106](https://github.com/bigknoxy/smallcode-jk/issues/106)) ([4508ae1](https://github.com/bigknoxy/smallcode-jk/commit/4508ae1b6f56b6d2921dc9225addfa67cd4d3f60))
* **cli:** single-shot escalate-on-failure — retry a bigger local model when the small one fails ([#89](https://github.com/bigknoxy/smallcode-jk/issues/89)) ([33d374b](https://github.com/bigknoxy/smallcode-jk/commit/33d374bd7097c8c3031552dbc1f20ba1a5223d46))
* **eval:** behavioral fingerprinting — catch cost drift invisible to pass@k (P1[#4](https://github.com/bigknoxy/smallcode-jk/issues/4)) ([#99](https://github.com/bigknoxy/smallcode-jk/issues/99)) ([e75428b](https://github.com/bigknoxy/smallcode-jk/commit/e75428b802b9c4589ac4e34b7d0cc919ec52899f))
* **eval:** eval run --save-transcripts — persist per-trial transcripts ([#95](https://github.com/bigknoxy/smallcode-jk/issues/95)) ([#102](https://github.com/bigknoxy/smallcode-jk/issues/102)) ([3ed3025](https://github.com/bigknoxy/smallcode-jk/commit/3ed3025c783ca2fe76cb98d26560f9cec961c368))
* **eval:** lucky-pass audit — model-solved vs harness-rescued attribution + first audit findings ([#114](https://github.com/bigknoxy/smallcode-jk/issues/114)) ([b1146ec](https://github.com/bigknoxy/smallcode-jk/commit/b1146ecaeb01cc53835fb989e6b4f43755b5b776))
* **eval:** lucky-pass process-quality scoring over stored transcripts (P0) ([#93](https://github.com/bigknoxy/smallcode-jk/issues/93)) ([f4cf2dc](https://github.com/bigknoxy/smallcode-jk/commit/f4cf2dc4556a0f143f8736e6c192bad13f642fda))
* **eval:** realrepo hard tier — 8 de-saturating tasks (multi-file localization + multi-line structural) ([#112](https://github.com/bigknoxy/smallcode-jk/issues/112)) ([4c49121](https://github.com/bigknoxy/smallcode-jk/commit/4c4912111b06fdf4250fc6f7cafa0682eccf2552))
* **eval:** repair-path telemetry — measure the edit-format payoff ceiling (baseline 0%) ([#98](https://github.com/bigknoxy/smallcode-jk/issues/98)) ([1e153da](https://github.com/bigknoxy/smallcode-jk/commit/1e153da09321795406d970e470f2a57567712fc0))
* **repair:** crack the lru-recency floor — model-side RAD hint + harness statement-repair ([#115](https://github.com/bigknoxy/smallcode-jk/issues/115)) ([9d42c0d](https://github.com/bigknoxy/smallcode-jk/commit/9d42c0d603f8228e3f789a22bbc028aaaf97b1da))
* **repair:** extend operator-mutation repair to logical (&&↔||) + arithmetic (+↔-) ([#110](https://github.com/bigknoxy/smallcode-jk/issues/110)) ([24cb1fb](https://github.com/bigknoxy/smallcode-jk/commit/24cb1fb19f986bd2547732aee7abd25a7949c949))
* **repair:** flip SMALLCODE_MUTATION_REPAIR default ON — regression-clean, realrepo 0.88→0.94 ([#109](https://github.com/bigknoxy/smallcode-jk/issues/109)) ([6fb6739](https://github.com/bigknoxy/smallcode-jk/commit/6fb6739aed989f1e25d653129e229874be0194b4))
* **repair:** harness-side operator-mutation repair — cracks the mri floor 0.00→0.88 (CI-significant) ([#108](https://github.com/bigknoxy/smallcode-jk/issues/108)) ([08e44a0](https://github.com/bigknoxy/smallcode-jk/commit/08e44a09b910bbe9d618770d67343d1b9ed34438))
* **repair:** mutate the pristine pre-model file first — lifts mri 0.70→1.00 ([#111](https://github.com/bigknoxy/smallcode-jk/issues/111)) ([7d8cdc0](https://github.com/bigknoxy/smallcode-jk/commit/7d8cdc0274d41cfdc396555c51b1264070b6af1e))


### Bug Fixes

* **cli:** apply edits headlessly instead of auto-declining when requireApproval is on ([#91](https://github.com/bigknoxy/smallcode-jk/issues/91)) ([#100](https://github.com/bigknoxy/smallcode-jk/issues/100)) ([4d77249](https://github.com/bigknoxy/smallcode-jk/commit/4d772498657c61a1b31c27a1efd1d9195ed4611b))
* **eval:** lucky-pass — clean diagnose→fix is Ideal, not Lucky (dequal forensic) ([#105](https://github.com/bigknoxy/smallcode-jk/issues/105)) ([40f1379](https://github.com/bigknoxy/smallcode-jk/commit/40f1379e10b164e49ce985dd6a5448d1f1a6309f))
* **eval:** lucky-pass — clean instant solves are Ideal, not Lucky ([#94](https://github.com/bigknoxy/smallcode-jk/issues/94)) ([d13eb71](https://github.com/bigknoxy/smallcode-jk/commit/d13eb71d9a78964c80ab845b8191a1fffc52e4e5))
* **eval:** run real trials in eval run/gate — --save-transcripts works from CLI ([#95](https://github.com/bigknoxy/smallcode-jk/issues/95) follow-up) ([#104](https://github.com/bigknoxy/smallcode-jk/issues/104)) ([7f8e377](https://github.com/bigknoxy/smallcode-jk/commit/7f8e3772e86122a72fe267d181cc48739ab42986))

## [1.6.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.5.0...v1.6.0) (2026-07-02)


### Features

* **cli:** --json output + smallcode fix (test-driven auto-fix) — the delegation/pre-commit primitive ([#85](https://github.com/bigknoxy/smallcode-jk/issues/85)) ([bac1bb4](https://github.com/bigknoxy/smallcode-jk/commit/bac1bb4d68d3e8d10715b121d5ac17f96c23ce04))


### Bug Fixes

* **agent:** retarget the lock when the model persistently edits a mis-pinned file (unblock the real target) ([#87](https://github.com/bigknoxy/smallcode-jk/issues/87)) ([1caab23](https://github.com/bigknoxy/smallcode-jk/commit/1caab23c9487092f12062fbce97280ec82c8062d))
* **retrieval:** dominant boost for files named verbatim in the query ([#88](https://github.com/bigknoxy/smallcode-jk/issues/88)) ([#88](https://github.com/bigknoxy/smallcode-jk/issues/88)) ([f59bfab](https://github.com/bigknoxy/smallcode-jk/commit/f59bfaba2e3d61e8ac11428e83312e71fec4c1a9))

## [1.5.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.4.1...v1.5.0) (2026-07-01)


### Features

* **context:** deprioritize test/fixture/vendor paths in edit-target selection ([#83](https://github.com/bigknoxy/smallcode-jk/issues/83)) ([3af5d4f](https://github.com/bigknoxy/smallcode-jk/commit/3af5d4f9147c38c542e836b27c5740dea892b951))
* **edit:** hard-reject off-target edits when a confident fix target exists (drift enforcement) ([#80](https://github.com/bigknoxy/smallcode-jk/issues/80)) ([52bad7b](https://github.com/bigknoxy/smallcode-jk/commit/52bad7be44e41c18528ca9332b005b4105051cc7))


### Bug Fixes

* **agent:** keep the loop anchored to the target file until the failing test passes (off-task drift) ([#79](https://github.com/bigknoxy/smallcode-jk/issues/79)) ([a558460](https://github.com/bigknoxy/smallcode-jk/commit/a55846090e57755dc2cfdc47eaa5db90f0a35dda))
* **agent:** lock to a stable run-level target so drift can't move the enforcement target ([#81](https://github.com/bigknoxy/smallcode-jk/issues/81)) ([92a81a7](https://github.com/bigknoxy/smallcode-jk/commit/92a81a76cc8545b8207c3527152bc3f3b2a6d415))
* **agent:** revert build-breaking write_file edits — close the "never leave repo broken" gap ([#75](https://github.com/bigknoxy/smallcode-jk/issues/75)) ([8337167](https://github.com/bigknoxy/smallcode-jk/commit/83371674f3736bf6d15cf5508f605f002f5c8e49))
* **context:** exclude .claude/dist/generated dirs + honor .gitignore in walkRepo (retrieval scope) ([#82](https://github.com/bigknoxy/smallcode-jk/issues/82)) ([edbb14b](https://github.com/bigknoxy/smallcode-jk/commit/edbb14b969e62e6a7aa13780cbb165eb656286e3))
* **edit:** recover from whole-file-vs-PATCH mismatch instead of looping ([#78](https://github.com/bigknoxy/smallcode-jk/issues/78)) ([ce20df4](https://github.com/bigknoxy/smallcode-jk/commit/ce20df4cc44c557bbeb38bc2e27f1a54935d9f27))
* **verify:** revert-guarantee gap [#2](https://github.com/bigknoxy/smallcode-jk/issues/2) — Tier 2 typecheck failures never set regressed ([#77](https://github.com/bigknoxy/smallcode-jk/issues/77)) ([6bfff71](https://github.com/bigknoxy/smallcode-jk/commit/6bfff719810fbb7cf3f7aec504dad814fde2b627))

## [1.4.1](https://github.com/bigknoxy/smallcode-jk/compare/v1.4.0...v1.4.1) (2026-07-01)


### Miscellaneous Chores

* release 1.4.1 ([#72](https://github.com/bigknoxy/smallcode-jk/issues/72)) ([c6714a4](https://github.com/bigknoxy/smallcode-jk/commit/c6714a4180cd2045ae4ffedfdf7580d39180ed1a))

## [1.4.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.3.0...v1.4.0) (2026-06-30)


### Features

* **agent:** R1 model-escalation ladder on the Best-of-N seam ([#56](https://github.com/bigknoxy/smallcode-jk/issues/56)) ([af752b6](https://github.com/bigknoxy/smallcode-jk/commit/af752b62830c65d275575b374fd1589ad0c57a2b))
* **cli:** R1 escalation UX — config ladder + CLI flags + run-level Best-of-N on live repos ([#57](https://github.com/bigknoxy/smallcode-jk/issues/57)) ([81b30e2](https://github.com/bigknoxy/smallcode-jk/commit/81b30e2d05db6142ba6d94a19d3654a921a1dc3e))
* **cli:** R9 dev-UX — smallcode chat interactive multi-task REPL ([#66](https://github.com/bigknoxy/smallcode-jk/issues/66)) ([0bf6aaa](https://github.com/bigknoxy/smallcode-jk/commit/0bf6aaac426d0ce02a8251e51ba66a190cbd01d4))
* **cli:** R9 dev-UX — smallcode diff / undo + post-run change summary ([#65](https://github.com/bigknoxy/smallcode-jk/issues/65)) ([7268470](https://github.com/bigknoxy/smallcode-jk/commit/7268470dce369815edfe46f34281d1e2905f091d))
* **cli:** R9 diff-review-before-write — approve each edit when requireApproval is on ([#67](https://github.com/bigknoxy/smallcode-jk/issues/67)) ([36b06c3](https://github.com/bigknoxy/smallcode-jk/commit/36b06c3e362ff9d00526a804dc325a7de4a3e05b))
* **edit:** reject test-file edits (anti-fake-green) + docs drift fixes ([#44](https://github.com/bigknoxy/smallcode-jk/issues/44)) ([c3f4f50](https://github.com/bigknoxy/smallcode-jk/commit/c3f4f507e1ed7e17af24a39c5d899c30d1171aeb))
* **edit:** revert-on-regression + format-consistent not-applied feedback ([#40](https://github.com/bigknoxy/smallcode-jk/issues/40)) ([61619f9](https://github.com/bigknoxy/smallcode-jk/commit/61619f9a22c1b563443ba06c9a5aa622a1198372))
* **eval:** expand realrepo suite 7→12 + idempotent task-integrity validator ([#50](https://github.com/bigknoxy/smallcode-jk/issues/50)) ([434c9ac](https://github.com/bigknoxy/smallcode-jk/commit/434c9ac3b45ca719ccbc36d4bd1d858c4899fc8d))
* **eval:** R5 Aider polyglot-benchmark harness (JS) + edit-format-% metric ([#59](https://github.com/bigknoxy/smallcode-jk/issues/59)) ([63aa2ef](https://github.com/bigknoxy/smallcode-jk/commit/63aa2ef414291e95d00fedb0a19242b54fa5a55a))
* **eval:** SMALLCODE_TASK_FILTER + scripts/forensic-task.ts (test-source feedback refuted) ([#52](https://github.com/bigknoxy/smallcode-jk/issues/52)) ([67229ae](https://github.com/bigknoxy/smallcode-jk/commit/67229aeb1741131d1564ecfa187c41b790925f28))
* **eval:** SWE-bench-Lite ingestion harness + honest runner (no fabricated number) ([#64](https://github.com/bigknoxy/smallcode-jk/issues/64)) ([cf5c4cf](https://github.com/bigknoxy/smallcode-jk/commit/cf5c4cf92848209a95b5e2b05cf3b95cd7010f28))
* **eval:** wire run-level oracle-verified Best-of-N into the eval harness ([#46](https://github.com/bigknoxy/smallcode-jk/issues/46)) ([effdd78](https://github.com/bigknoxy/smallcode-jk/commit/effdd78b3feaf18a382e7e5576056078078292be))
* **gepa:** live reflective mutator — frontier reflector evolves qwen's prompts ([#38](https://github.com/bigknoxy/smallcode-jk/issues/38)) ([d7f2dd8](https://github.com/bigknoxy/smallcode-jk/commit/d7f2dd8bd085040fb04d5904f079d6230cb42921))
* **gepa:** register qwen2.5-coder:32b reflector + SMALLCODE_PROMPTSET held-out A/B knob ([#41](https://github.com/bigknoxy/smallcode-jk/issues/41)) ([468f3ed](https://github.com/bigknoxy/smallcode-jk/commit/468f3ed2fa0185e2e6c24a324710a82ebdd06726))
* **verify:** extend static confidence into the loop — revert a broken edit even with no tests ([#63](https://github.com/bigknoxy/smallcode-jk/issues/63)) ([9dc9e24](https://github.com/bigknoxy/smallcode-jk/commit/9dc9e2466e8d35a47943cc74b73c89d7859e1147))
* **verify:** oracle-free static-confidence ladder — honest grade when no test covers a change ([#61](https://github.com/bigknoxy/smallcode-jk/issues/61)) ([bd654a6](https://github.com/bigknoxy/smallcode-jk/commit/bd654a68c27541c692bfe26bdaa6997e552b6ed9))
* **verify:** R2 externalize-localization — surface the source line of runtime throws ([#54](https://github.com/bigknoxy/smallcode-jk/issues/54)) ([22d85a2](https://github.com/bigknoxy/smallcode-jk/commit/22d85a207a521254e12b938c47777f923f52cf78))
* **verify:** R4 validate-before-commit — introduced load/compile error = hard regression ([#53](https://github.com/bigknoxy/smallcode-jk/issues/53)) ([1f13c90](https://github.com/bigknoxy/smallcode-jk/commit/1f13c90e61ef9b1b1316d6552e3ba4d2a5b7b587))


### Bug Fixes

* **cli:** scope undo to the agent's changes — never discard the user's own work ([#68](https://github.com/bigknoxy/smallcode-jk/issues/68)) ([17b81f1](https://github.com/bigknoxy/smallcode-jk/commit/17b81f186ac659c4ff00cdf491e6799d187b498a))
* **context:** exact symbol-name match dominates retrieval ranking (21/22 → 22/22) ([#58](https://github.com/bigknoxy/smallcode-jk/issues/58)) ([cfea46e](https://github.com/bigknoxy/smallcode-jk/commit/cfea46ea9ef6ae701fb210ef7aad1b83f540d31b))
* **eval:** force clean process exit in run-baseline (Ollama keep-alive hang) ([#49](https://github.com/bigknoxy/smallcode-jk/issues/49)) ([1f301ad](https://github.com/bigknoxy/smallcode-jk/commit/1f301ad53e9343e9162346f675104b4657dd9716))
* **gepa:** SMALLCODE_GEPA_REFLECT_TIMEOUT — stop reflector silent no-op ([#45](https://github.com/bigknoxy/smallcode-jk/issues/45)) ([4e61897](https://github.com/bigknoxy/smallcode-jk/commit/4e618971a23afcc4610d737f5c6721c3ee21df04))
* **prompt:** human-readable label for anonymous export-default edit targets ([#43](https://github.com/bigknoxy/smallcode-jk/issues/43)) ([980ddbf](https://github.com/bigknoxy/smallcode-jk/commit/980ddbfb2336f87248e565e85d246b6b4ef192ec))

## [1.3.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.2.2...v1.3.0) (2026-06-26)


### Features

* **eval:** compare-runs.ts — one-command CI-overlap A/B verdict ([#28](https://github.com/bigknoxy/smallcode-jk/issues/28)) ([efaa2af](https://github.com/bigknoxy/smallcode-jk/commit/efaa2afece122536d02ad868457c6332d8fc8963))
* **eval:** pass@k with bootstrap CIs + grader infra-retry — trustworthy measuring stick (PR1) ([#26](https://github.com/bigknoxy/smallcode-jk/issues/26)) ([bd6cbc3](https://github.com/bigknoxy/smallcode-jk/commit/bd6cbc321886802e7935f57a4b12397eede28466))
* gold-standard iteration — multi-file retrieval + diff default-on + cross-file eval task ([#34](https://github.com/bigknoxy/smallcode-jk/issues/34)) ([c242042](https://github.com/bigknoxy/smallcode-jk/commit/c24204235503cb1df0ab743f35ab91440d79d78e))
* qwen2.5-coder model support + bug-containing-function PATCH target selection ([#32](https://github.com/bigknoxy/smallcode-jk/issues/32)) ([d548099](https://github.com/bigknoxy/smallcode-jk/commit/d548099a60390a8e4825102f84b84eaf3fd904af))
* size-gated edit + target-file pinning (Option A) for small-model edit reliability ([#24](https://github.com/bigknoxy/smallcode-jk/issues/24)) ([7928096](https://github.com/bigknoxy/smallcode-jk/commit/79280968a53a4de9e15bf6c164da29c10fbedd72))
* size-gated minimal-diff PATCH edit format (confirmed +0.17 OVERALL) ([#33](https://github.com/bigknoxy/smallcode-jk/issues/33)) ([5586979](https://github.com/bigknoxy/smallcode-jk/commit/558697959839fcdf22a1e6833e5c8f25620323e1))


### Bug Fixes

* **eval:** treat empty-generation wedge as infra error, not a 0.00 ([#31](https://github.com/bigknoxy/smallcode-jk/issues/31)) ([a8372c1](https://github.com/bigknoxy/smallcode-jk/commit/a8372c1ea190fec40c4c882f39364d247afc52ab))

## [1.2.2](https://github.com/bigknoxy/smallcode-jk/compare/v1.2.1...v1.2.2) (2026-06-25)


### Bug Fixes

* **edit,verify:** edit-apply reliability + oracle honesty (wire repair, guard truncation, path-typo rescue, fully-green solved) ([#21](https://github.com/bigknoxy/smallcode-jk/issues/21)) ([6de9d1f](https://github.com/bigknoxy/smallcode-jk/commit/6de9d1f07e326faddbf299ddd13056f4f09a49fb))

## [1.2.1](https://github.com/bigknoxy/smallcode-jk/compare/v1.2.0...v1.2.1) (2026-06-25)


### Bug Fixes

* **planner:** drop goals that parrot the planner's own instructions ([#7](https://github.com/bigknoxy/smallcode-jk/issues/7)) ([#19](https://github.com/bigknoxy/smallcode-jk/issues/19)) ([071dadd](https://github.com/bigknoxy/smallcode-jk/commit/071dadd7b53e5ef1818697a00cc2a8598d4902c8))

## [1.2.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.1.1...v1.2.0) (2026-06-25)


### Features

* **loop:** redraft-on-think-only recovery (answer-now prompt) ([#17](https://github.com/bigknoxy/smallcode-jk/issues/17)) ([60b8002](https://github.com/bigknoxy/smallcode-jk/commit/60b8002c8f46d8f808e26479e2c65940ad772821))

## [1.1.1](https://github.com/bigknoxy/smallcode-jk/compare/v1.1.0...v1.1.1) (2026-06-25)


### Bug Fixes

* derive context budget from num_ctx + per-turn prompt-fit guard ([afb83df](https://github.com/bigknoxy/smallcode-jk/commit/afb83df21243ec5712946d9adc614cae8e2daf8c))
* derive context budget from num_ctx + per-turn prompt-fit guard ([f71ecb5](https://github.com/bigknoxy/smallcode-jk/commit/f71ecb522839b935fc5f56852f9b7852a8feb402))

## [1.1.0](https://github.com/bigknoxy/smallcode-jk/compare/v1.0.2...v1.1.0) (2026-06-25)


### Features

* **gepa:** add PromptSet.skill slot + offline transcript skill distiller ([#12](https://github.com/bigknoxy/smallcode-jk/issues/12)) ([84318c3](https://github.com/bigknoxy/smallcode-jk/commit/84318c31f2af56b925521d6154dbbe59f8f755f8))


### Bug Fixes

* **cli:** report honest completion verdict; stop parroting planner example ([#13](https://github.com/bigknoxy/smallcode-jk/issues/13)) ([244a4e0](https://github.com/bigknoxy/smallcode-jk/commit/244a4e0847ad6ac84c1a6b9da6321fee19801d0d))

## [1.0.2](https://github.com/bigknoxy/smallcode-jk/compare/v1.0.1...v1.0.2) (2026-06-24)


### Bug Fixes

* **planner:** filter path-echo goals, sanitise context summary, cap decomposition ([dd03f30](https://github.com/bigknoxy/smallcode-jk/commit/dd03f302a8e8badae9b60d06df4c0f523a850bf5))
* **planner:** stop junk-goal echoes + over-decomposition ([31274e7](https://github.com/bigknoxy/smallcode-jk/commit/31274e79e6450f6d885e4620f65eb3da512b30ad))

## [1.0.1](https://github.com/bigknoxy/smallcode-jk/compare/v1.0.0...v1.0.1) (2026-06-24)


### Bug Fixes

* **install:** log() to stderr — real release-path install was broken ([679ecad](https://github.com/bigknoxy/smallcode-jk/commit/679ecade0b3a4c7dc7e1829ee74863e838a36a50))
* **install:** send log() to stderr so it can't pollute captured tarball URL ([fe1503c](https://github.com/bigknoxy/smallcode-jk/commit/fe1503ca92a4401e7610cb9f0cc988125d5e9922))

## 1.0.0 (2026-06-24)


### Features

* **bench:** add EvalPlus, LiveCodeBench, and bake-off benchmark harnesses ([bfc8419](https://github.com/bigknoxy/smallcode-jk/commit/bfc84190b9f4c3295b23296e96aa8a463dd58e6b))
* **dist:** one-line installer + smallcode update/uninstall + version 0.1.0 ([ce5a5ce](https://github.com/bigknoxy/smallcode-jk/commit/ce5a5ce271f693db20e6f68e1e3d85f02b40ee26))
* **edit:** add PATCH format for function-level edits on large files ([e6475af](https://github.com/bigknoxy/smallcode-jk/commit/e6475af484048283af2e3b7f47bd272cd1e5527d))
* **edit:** full-file rewrite format for small models ([f5f3523](https://github.com/bigknoxy/smallcode-jk/commit/f5f3523ee5c1fc3d5998106899b44fd6b5f1719c))
* **eval:** A/B toggles for discipline rules + pre-solve in baseline harness ([21ed372](https://github.com/bigknoxy/smallcode-jk/commit/21ed3725516b4e33a4911dd7277deae1f8717497))
* **evals:** MultiPL-E HumanEval-TS external benchmark runner ([39d20f2](https://github.com/bigknoxy/smallcode-jk/commit/39d20f28ccf22121cb98fb4f36954126f26f6e38))
* **improve:** GEPA prompt-optimization harness — seam + Pareto engine + tests ([69f3af9](https://github.com/bigknoxy/smallcode-jk/commit/69f3af9a8a2f1d99b65372886d4866421699bf83))
* Karpathy discipline rules + AlphaCodium-lite pre-solve reflection ([ebaee16](https://github.com/bigknoxy/smallcode-jk/commit/ebaee16f5a85597f25d516852cb579cf17f75f8e))
* **provider:** throughput watchdog + Ollama KV-cache serve script (1c+2a) ([373d294](https://github.com/bigknoxy/smallcode-jk/commit/373d294ec14c4aa553e5a3ca93d694f623435fe1))
* **site:** redesign landing page + add shared design-system stylesheet ([f8ee7de](https://github.com/bigknoxy/smallcode-jk/commit/f8ee7de604da99bb0745b40977ffbe7b342a207c))
* **site:** restyle docs pages to match shared design system ([694f2d0](https://github.com/bigknoxy/smallcode-jk/commit/694f2d02f6219ac03d25eaf5412f4ddb58a1b9e0))
* structured failure feedback + stall→redraft ([6f00eba](https://github.com/bigknoxy/smallcode-jk/commit/6f00eba1eb4d8e6171d8bf91e99ae6aacb7f84d3))
* tiered verification oracle — verify untested code via typecheck fallback ([6c301fe](https://github.com/bigknoxy/smallcode-jk/commit/6c301fe4de2727fd6f27483ba06419e8f015649d))
* wire repo context into CLI + run-level Best-of-N; full HumanEval-TS validation ([4159068](https://github.com/bigknoxy/smallcode-jk/commit/4159068e754eeb688a8cb78c5500c554637aab58))


### Bug Fixes

* **agent:** execute tool calls + early-stop on green tests ([3f6d23a](https://github.com/bigknoxy/smallcode-jk/commit/3f6d23a17c7ffae28773694d3c4915a071568333))
* **agent:** wire planTask into runLoop; fix zero-turn silent failure ([7b58e66](https://github.com/bigknoxy/smallcode-jk/commit/7b58e669b7b874cb82ac8e5382d802606c24c2c4))
* **eval:** per-trial hard timeout + grader hang prevention ([06665c4](https://github.com/bigknoxy/smallcode-jk/commit/06665c4fa29b64833e8d5850742d4778e0b8cea4))
* **eval:** provide real file context to agent; import lstat at top ([8ea572e](https://github.com/bigknoxy/smallcode-jk/commit/8ea572ec6c56d0b7b2f9d1c7ed287203086cff68))
* **eval:** raise trial timeout to 20 min — VibeThinker-3B call latency ([cf42c03](https://github.com/bigknoxy/smallcode-jk/commit/cf42c035016a0d0aa8d854d9b33cc11854d610eb))
* gold-standard failure-diagnostic + stall→redraft hardening ([fffcb7a](https://github.com/bigknoxy/smallcode-jk/commit/fffcb7a27163c10e95e263c13ecbb8662632e394))
* **oracle:** baseline-relative early-stop for pre-existing test failures ([4c42bff](https://github.com/bigknoxy/smallcode-jk/commit/4c42bff425bd028dc216a616cdd988af2d528732))
* **oracle:** count guard so error-type failures can't be false-solved ([f43d59d](https://github.com/bigknoxy/smallcode-jk/commit/f43d59d871413ba0726c3c352ecdc296cd0d2b84))
* **parser:** accept 6–8 angle brackets in SEARCH/REPLACE markers ([45f575f](https://github.com/bigknoxy/smallcode-jk/commit/45f575f1a66b701b0f81ac66bfb5af4e2d978f92))
* **parser:** accept unlimited angle brackets (6+) in SEARCH/REPLACE ([bf95a37](https://github.com/bigknoxy/smallcode-jk/commit/bf95a37a5c64292fbe1fb588e196760760e3c69c))
* **prompt:** concrete few-shot example + directive turn format ([8cf809e](https://github.com/bigknoxy/smallcode-jk/commit/8cf809e19b6340496ffcf155d913d5b243a2863e))
* **provider+registry:** single stream timer, num_ctx 32K→8K ([c6a1299](https://github.com/bigknoxy/smallcode-jk/commit/c6a12996448431e92998e1b96bd877e31405b484))
* **provider:** keep AbortController alive through response.json() ([435481c](https://github.com/bigknoxy/smallcode-jk/commit/435481c54e3000f11b100c5e723ae31a6ef7931c))
* **provider:** per-read timeout races to interrupt blocked reader.read() ([6141cbe](https://github.com/bigknoxy/smallcode-jk/commit/6141cbe58c7d15e441b3da09c1ec2e085c713c61))
* **provider:** persistent abort promise to interrupt reader.read() ([ac52a08](https://github.com/bigknoxy/smallcode-jk/commit/ac52a087ab0ff2ad68ba2f98b66e2fd7ccf5cc99))
* **provider:** Promise.race for hard timeout on complete() ([73f27fd](https://github.com/bigknoxy/smallcode-jk/commit/73f27fd0c373118944790913dba9d07495cc534e))
* **provider:** request stream_options.include_usage for token counts in streaming ([2dbb942](https://github.com/bigknoxy/smallcode-jk/commit/2dbb942bee27d655810a81c5db9963b5faa77eea))
* **provider:** single timeout covers fetch() AND stream read ([c71d647](https://github.com/bigknoxy/smallcode-jk/commit/c71d64744036992bc567fec83001954a680e64a9))
* **provider:** use streaming internally in complete() — clean abort ([0f2f664](https://github.com/bigknoxy/smallcode-jk/commit/0f2f664a38faaf5c90174507241d2c7f8596a293))
* redundant else-if in stall reset (TS2367) ([db19fc8](https://github.com/bigknoxy/smallcode-jk/commit/db19fc8ba501fe6c2b15e38f982f24ad28e31b30))
* **security:** path traversal in loop.ts injected read/write helpers ([d2ca892](https://github.com/bigknoxy/smallcode-jk/commit/d2ca892aa48c8826e5763d9d6a349db4c705f159))
* tsc compliance for merged batch ([bb1689a](https://github.com/bigknoxy/smallcode-jk/commit/bb1689a087a044a145ca8c52788afae72415d22f))


### Reverts

* remove terse-CoT prompt directives (regressed pass rate) ([641382a](https://github.com/bigknoxy/smallcode-jk/commit/641382a105b6f9db57b1c2c0717b7fc710321399))

## Changelog

All notable changes to this project will be documented in this file.

This file is managed by [release-please](https://github.com/googleapis/release-please).
