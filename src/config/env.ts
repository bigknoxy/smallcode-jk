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
};

/** Metadata for discoverability / `smallcode config env` listing. */
export interface EnvVarDoc { name: string; parse: "bool" | "int"; default: string; description: string; }
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
];
