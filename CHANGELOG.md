# Changelog

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
