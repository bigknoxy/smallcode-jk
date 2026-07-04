// Central registry of core-runtime environment flags. One declaration per var so
// every gated behavior is discoverable + auditable in one place (vs scattered
// raw process.env reads). Getters read process.env live so tests can set/unset.

function boolEnv(name: string, defaultOn: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultOn;
  return defaultOn ? v !== "0" : v === "1";
}

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Live-read accessors for core-runtime flags. */
export const env = {
  get localize(): boolean { return boolEnv("SMALLCODE_LOCALIZE", false); },
  get validateEdit(): boolean { return boolEnv("SMALLCODE_VALIDATE_EDIT", true); },
  get staticConfidence(): boolean { return boolEnv("SMALLCODE_STATIC_CONFIDENCE", true); },
  get diffEdit(): boolean { return boolEnv("SMALLCODE_DIFF_EDIT", true); },
  get diffMinFnLines(): number { return intEnv("SMALLCODE_DIFF_MIN_FN", 30); },
  get targetPin(): boolean { return boolEnv("SMALLCODE_TARGET_PIN", true); },
  get graderRetries(): number { return intEnv("SMALLCODE_GRADER_RETRIES", 1); },
  get watchdog(): boolean { return boolEnv("SMALLCODE_WATCHDOG", true); },
  get targetLock(): boolean { return boolEnv("SMALLCODE_TARGET_LOCK", true); },
  get phaseGate(): boolean { return boolEnv("SMALLCODE_PHASE_GATE", false); },
  get saveTranscripts(): boolean { return boolEnv("SMALLCODE_SAVE_TRANSCRIPTS", false); },
  get r2ForceLine(): string | undefined { const v = process.env["SMALLCODE_R2_FORCE_LINE"]; return v && v.trim() ? v.trim() : undefined; },
  get mutationRepair(): boolean { return boolEnv("SMALLCODE_MUTATION_REPAIR", true); },
  get mutationRepairMax(): number { return intEnv("SMALLCODE_MUTATION_REPAIR_MAX", 60); },
  get radHint(): boolean { return boolEnv("SMALLCODE_RAD_HINT", true); },
  get statementRepair(): boolean { return boolEnv("SMALLCODE_STATEMENT_REPAIR", false); },
  get finalStateGuard(): boolean { return boolEnv("SMALLCODE_FINAL_STATE_GUARD", false); },
  get importGate(): boolean { return boolEnv("SMALLCODE_IMPORT_GATE", false); },
};

/** Metadata for discoverability / `smallcode config env` listing. */
export interface EnvVarDoc { name: string; parse: "bool" | "int" | "string"; default: string; description: string; }
export const ENV_REGISTRY: EnvVarDoc[] = [
  { name: "SMALLCODE_LOCALIZE", parse: "bool", default: "off", description: "R2 externalize-localization: surface the source line of a runtime throw in the next prompt." },
  { name: "SMALLCODE_VALIDATE_EDIT", parse: "bool", default: "on", description: "R4 validate-before-commit: treat an edit that fails to load/compile as a regression." },
  { name: "SMALLCODE_STATIC_CONFIDENCE", parse: "bool", default: "on", description: "Oracle-free static-confidence grade on the no-test path (broken/parses/type-clean)." },
  { name: "SMALLCODE_DIFF_EDIT", parse: "bool", default: "on", description: "Size-gated minimal-diff PATCH format for large functions." },
  { name: "SMALLCODE_DIFF_MIN_FN", parse: "int", default: "30", description: "Min function line-count for the minimal-diff PATCH format." },
  { name: "SMALLCODE_TARGET_PIN", parse: "bool", default: "on", description: "Pin the scored edit-target file as a whole undroppable context chunk." },
  { name: "SMALLCODE_GRADER_RETRIES", parse: "int", default: "1", description: "Deterministic grader infra-error retry count." },
  { name: "SMALLCODE_WATCHDOG", parse: "bool", default: "on", description: "Throughput watchdog: unload/reload the model on KV-cache decay." },
  { name: "SMALLCODE_TARGET_LOCK", parse: "bool", default: "on", description: "Hard-reject FILE:/PATCH:/write_file edits to a file other than the confidently-pinned fix target while the run is in fix-mode (baseline had a failing test)." },
  { name: "SMALLCODE_PHASE_GATE", parse: "bool", default: "off", description: "P0#2 statewright-style phase gate: while no target is confidently pinned and no file has been read yet (\"explore\" phase), advertise only read/inspect tools and hard-reject write_file/FILE:/PATCH: edits. A pinned/locked target is always \"edit\" phase (unchanged behavior)." },
  { name: "SMALLCODE_SAVE_TRANSCRIPTS", parse: "bool", default: "off", description: "eval run --save-transcripts: persist every trial's Transcript to the TranscriptStore layout (<transcriptsDir>/<taskId>/<id>.json) so scripts/classify-pass-quality.ts has real data. Honored by `smallcode eval run` and scripts/run-baseline.ts." },
  { name: "SMALLCODE_R2_FORCE_LINE", parse: "string", default: "(unset)", description: "R2 upper-bound PROBE only (format `relpath:line`, e.g. `src/index.js:90`). When a turn fails with a value-mismatch diagnostic that carries no natural throw-location, forces the R2 BUG LOCATION window onto the given source line. MEASUREMENT KNOB, never a shipped default: it uses knowledge the harness cannot itself derive for an assertion mismatch, to measure the ceiling of externalized localization (does handing the model the exact line lift a floor?)." },
  { name: "SMALLCODE_MUTATION_REPAIR", parse: "bool", default: "on", description: "Harness-side operator-mutation repair (DEFAULT ON; set =0 to disable). Last-resort pass after the model loop ends UNSOLVED in fix-mode (red baseline) with a locked fix-target file: brute-force every single operator flip — comparison (===↔!==, <↔<=, <↔>= …), logical (&&↔||), and arithmetic (+↔-) — in the target file, run the real oracle on each, and keep the first that goes fully green. Routes around the sub-14B wall on wrong-operator bugs (e.g. mri) that no model-side lever moves. Deterministic; can't fake-green (requires full-green oracle); reverts every non-winning candidate; fires only on already-failing runs so it never slows a successful one. A/B: mri 0.00→0.88 (CI-significant), realrepo suite 0.90→~0.95, edit-reliability 0.99→1.00, zero regression." },
  { name: "SMALLCODE_MUTATION_REPAIR_MAX", parse: "int", default: "60", description: "Cap on operator-mutation candidates tried per repair pass (bounds oracle-run cost on large files). Candidates are priority-ordered (equality inversions first); the pass logs when the cap truncates the list." },
  { name: "SMALLCODE_RAD_HINT", parse: "bool", default: "on", description: "Model-side read-after-delete hint: when a failing turn leaves the `X.delete(K); X.set(K, X.get(K))` ordering bug (reads the just-deleted key → stores undefined) on the locked target, surface a targeted hint in the next prompt so the MODEL reorders the read before the delete. Prompt signal only — passes stay attributed to the model, not the harness. Cracked the lru-recency floor 0.00→1.00 CI-significant (7b, n=8), audit-attributed model-solved (rescued 0); full 22-task realrepo A/B showed zero lever fires outside the exact pattern, so it is inert everywhere else. Default ON since v1.7.1." },
  { name: "SMALLCODE_STATEMENT_REPAIR", parse: "bool", default: "off", description: "Harness-side statement-repair: last-resort pass after the model loop ends UNSOLVED in fix-mode with a locked target. If the target contains a single read-after-delete ordering bug (`X.delete(K); X.set(K, X.get(K))`), deterministically hoist the read into a temp before the delete, run the real oracle, keep it if fully green. Recorded as a harness rescue (mutationRepair) so pass-quality classification attributes it to the harness, not the model. Complements operator-mutation repair (disjoint bug shape). Default OFF." },
  { name: "SMALLCODE_IMPORT_GATE", parse: "bool", default: "off", description: "Static import-resolution gate (Lever 2, opt-in): after a FILE:/PATCH: edit lands, extract the import specifiers the edit INTRODUCED and resolve each against ground truth — relative paths against the filesystem, bare packages against package.json deps + node_modules (Bun's resolver) — BEFORE the test oracle runs. Any specifier that does not resolve (a hallucinated module, the dogfood `std/strings` failure) reverts that file to its pre-edit content and feeds the model a targeted `IMPORT ERROR — … does not resolve … this repo's dependencies are: …` message that names the deps that DO exist. Proactive fix for the reactive-only R4 path (which only surfaces `Cannot find module` after a full test run, and only when a test imports the edited file), so the model gets a crisp, earlier, more actionable signal instead of looping on the same invented import. Conservative (a declared dep or any Bun-resolvable specifier passes) to keep false-rejects near zero. Only NEW imports are checked; pre-existing unresolved imports are never held against the edit. Deterministic; module in src/verify/import-check.ts. Default OFF (opt-in pending validation, then promotion)." },
  { name: "SMALLCODE_FINAL_STATE_GUARD", parse: "bool", default: "off", description: "Final-state regression guard ('never leave the repo worse than found'): last pass after the model loop AND every repair pass end with the run still UNSOLVED. Recaptures the full test baseline on the FINAL disk state and compares to the run-START baseline; if the repo is STRICTLY WORSE (higher red count OR a test failing now that was green/absent at baseline), restores every file the agent touched to its pristine pre-model content (and deletes any brand-new files it created), then re-verifies the restore reached ≤ baseline. Eval-neutral by construction: only fires on unsolved runs and reverts to the seeded-bug start state, so pass/fail is unchanged — it removes broken residue a partial/wandering run would otherwise leave on disk. Deterministic, model-agnostic. Default OFF (opt-in pending dogfood validation, then promotion)." },
];
