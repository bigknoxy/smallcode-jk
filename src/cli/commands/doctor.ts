import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isGitRepo } from "@/util/git.ts";
import { loadConfig } from "../../config/loader.ts";
import { listOllamaModels, modelIsPulled, ollamaNativeBase, pingOllama } from "../../models/ollama.ts";
import { ModelRegistry } from "../../models/registry.ts";
import type { ParsedArgs } from "../args.ts";

/**
 * `smallcode doctor` — one command that diagnoses the whole local setup and
 * prints a copy-pasteable fix for anything broken, so a new user reaches a
 * working `smallcode run` without hunting through docs. The logic is split into
 * a PURE `buildDoctorChecks(facts)` (fully unit-tested: the ✓/✗ verdicts, the fix
 * strings, and which failures are fatal) and an I/O `gatherDoctorFacts` that
 * probes Ollama / config / git.
 */

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** A P0 failure exits non-zero (it blocks a run); a warn is advisory. */
  level: "P0" | "warn";
  /** What was found. */
  detail: string;
  /** Copy-pasteable fix, shown only when the check failed. */
  fix?: string;
}

export interface DoctorFacts {
  bunVersion: string;
  ollamaOnPath: boolean;
  /** Native Ollama root (already `/v1`-stripped) for display. */
  endpoint: string;
  serverReachable: boolean;
  serverError?: string;
  /** Active model id, or undefined when config is missing/invalid. */
  activeModel?: string;
  installedModels: string[];
  configOk: boolean;
  configError?: string;
  /** Is the active model id a known registry profile (or a config extra)? */
  modelRegistered: boolean;
  isGitRepo: boolean;
  hasTestRunner: boolean;
}

/** Build the ordered check list from gathered facts. Pure; exported for testing. */
export function buildDoctorChecks(f: DoctorFacts): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // 1. Bun — we are running in it, so this is informational.
  checks.push({ name: "Bun runtime", ok: true, level: "warn", detail: `bun ${f.bunVersion}` });

  // 2. Ollama CLI on PATH (needed to pull models).
  checks.push({
    name: "Ollama CLI",
    ok: f.ollamaOnPath,
    level: "warn",
    detail: f.ollamaOnPath ? "`ollama` on PATH" : "`ollama` not found on PATH",
    fix: f.ollamaOnPath ? undefined : "Install Ollama: https://ollama.com/download",
  });

  // 3. Ollama server reachable — P0, nothing runs without it.
  checks.push({
    name: "Ollama server",
    ok: f.serverReachable,
    level: "P0",
    detail: f.serverReachable
      ? `reachable at ${f.endpoint}`
      : `NOT reachable at ${f.endpoint}${f.serverError ? ` (${f.serverError})` : ""}`,
    fix: f.serverReachable ? undefined : "Start it: ollama serve   (or open the Ollama app)",
  });

  // 4. Config file valid + parseable — P0.
  checks.push({
    name: "Config",
    ok: f.configOk,
    level: "P0",
    detail: f.configOk
      ? `valid (active model: ${f.activeModel})`
      : `invalid or missing${f.configError ? ` — ${f.configError}` : ""}`,
    fix: f.configOk ? undefined : "Create one: smallcode config init",
  });

  // 5. Active model id is known — P0 (only meaningful when config parsed).
  if (f.configOk) {
    checks.push({
      name: "Model id",
      ok: f.modelRegistered,
      level: "P0",
      detail: f.modelRegistered
        ? `"${f.activeModel}" is a known profile`
        : `"${f.activeModel}" is not a known model id`,
      fix: f.modelRegistered ? undefined : "See valid ids: smallcode config list-models",
    });
  }

  // 6. Active model actually pulled — P0, but only checkable when the server is up.
  if (f.configOk && f.activeModel !== undefined) {
    if (!f.serverReachable) {
      checks.push({
        name: "Model pulled",
        ok: false,
        level: "warn",
        detail: `can't check — Ollama server unreachable`,
        fix: "Fix the Ollama server check above first",
      });
    } else {
      const pulled = modelIsPulled(f.installedModels, f.activeModel);
      checks.push({
        name: "Model pulled",
        ok: pulled,
        level: "P0",
        detail: pulled ? `"${f.activeModel}" is installed` : `"${f.activeModel}" is not installed`,
        fix: pulled ? undefined : `ollama pull ${f.activeModel}`,
      });
    }
  }

  // 7. Git repo — warn (diff/undo/Best-of-N need it; a plain run does not).
  checks.push({
    name: "Git repo",
    ok: f.isGitRepo,
    level: "warn",
    detail: f.isGitRepo ? "working tree is a git checkout" : "not a git repo",
    fix: f.isGitRepo ? undefined : "git init   (enables smallcode diff/undo and Best-of-N)",
  });

  // 8. Test runner — warn (the oracle runs `bun test`).
  checks.push({
    name: "Test runner",
    ok: f.hasTestRunner,
    level: "warn",
    detail: f.hasTestRunner ? "package.json present (`bun test` oracle)" : "no package.json found",
    fix: f.hasTestRunner ? undefined : "The oracle runs `bun test`; add a package.json + tests",
  });

  return checks;
}

/** True iff any P0 check failed (→ non-zero exit). Pure; exported for testing. */
export function hasFatalFailure(checks: DoctorCheck[]): boolean {
  return checks.some((c) => c.level === "P0" && !c.ok);
}

/** Render the checks for the terminal. Pure; exported for testing. */
export function renderDoctor(checks: DoctorCheck[]): string {
  const lines: string[] = ["smallcode doctor — setup check", ""];
  for (const c of checks) {
    lines.push(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`    fix: ${c.fix}`);
  }
  lines.push("");
  lines.push(
    hasFatalFailure(checks)
      ? "✗ Not ready — fix the ✗ items above (P0), then re-run `smallcode doctor`."
      : "✓ Ready to run.",
  );
  return lines.join("\n");
}

async function gatherDoctorFacts(endpoint: string, repoRoot: string, configPath?: string): Promise<DoctorFacts> {
  // Ollama CLI on PATH.
  let ollamaOnPath = false;
  try {
    const proc = Bun.spawnSync(["ollama", "--version"], { stdout: "ignore", stderr: "ignore" });
    ollamaOnPath = (proc.exitCode ?? 1) === 0;
  } catch {
    ollamaOnPath = false;
  }

  const probe = await pingOllama(endpoint);
  const installedModels = probe.ok ? await listOllamaModels(endpoint) : [];

  // Config: parse + check the active model id against the registry (+ config extras).
  let configOk = false;
  let configError: string | undefined;
  let activeModel: string | undefined;
  let modelRegistered = false;
  try {
    const { config, extraModels } = loadConfig(configPath);
    configOk = true;
    activeModel = config.activeModel;
    const registry = new ModelRegistry(extraModels);
    modelRegistered = registry.has(activeModel);
  } catch (err) {
    configError = err instanceof Error ? err.message.split("\n")[0] : String(err);
  }

  return {
    bunVersion: Bun.version,
    ollamaOnPath,
    endpoint: ollamaNativeBase(endpoint),
    serverReachable: probe.ok,
    serverError: probe.error,
    activeModel,
    installedModels,
    configOk,
    configError,
    modelRegistered,
    isGitRepo: isGitRepo(repoRoot),
    hasTestRunner: existsSync(join(repoRoot, "package.json")),
  };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export async function doctorCommand(args: ParsedArgs): Promise<void> {
  const endpoint = flagString(args.flags, "endpoint") ?? "http://localhost:11434/v1";
  const repoRoot = resolve(flagString(args.flags, "repo") ?? process.cwd());
  const configPath = flagString(args.flags, "config");

  const facts = await gatherDoctorFacts(endpoint, repoRoot, configPath);
  const checks = buildDoctorChecks(facts);

  if (args.flags["json"] === true || args.flags["json"] === "true") {
    process.stdout.write(`${JSON.stringify({ ok: !hasFatalFailure(checks), checks })}\n`);
  } else {
    process.stdout.write(`${renderDoctor(checks)}\n`);
  }
  if (hasFatalFailure(checks)) process.exit(1);
}
