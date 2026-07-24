/**
 * Docs-drift checker (E5-T3). Pure helpers so the check is unit-tested; the I/O
 * wrapper is scripts/check-docs-sync.ts. Enforces the HARD no-drift rule
 * mechanically for the STRUCTURED, high-drift surfaces — the `SMALLCODE_*` env
 * flags (source of truth: `ENV_REGISTRY`) and the CLI subcommands (source of
 * truth: the `bin/smallcode.ts` dispatch) — by asserting each appears verbatim in
 * the public docs. A flag/command that exists in code but not in the docs (or a
 * doc that names one code removed) fails the check.
 */

/** Tokens (env var / command names) absent from the doc corpus. Pure. */
export function missingFromDocs(tokens: string[], corpus: string): string[] {
  return tokens.filter((t) => !corpus.includes(t));
}

/** Extract `case "<cmd>":` command names from the CLI dispatch source. Pure. */
export function extractCommands(binSource: string): string[] {
  const cmds = new Set<string>();
  for (const m of binSource.matchAll(/case\s+"([a-z][a-z-]*)":/g)) {
    if (m[1]) cmds.add(m[1]);
  }
  return [...cmds];
}

export interface DocsSyncReport {
  /** Env vars in ENV_REGISTRY missing from a given doc file. Keyed by doc name. */
  envMissing: Record<string, string[]>;
  /** CLI commands missing from a given doc file. Keyed by doc name. */
  cmdMissing: Record<string, string[]>;
  ok: boolean;
}

/**
 * Build the report: for each doc, which env vars / commands are undocumented.
 * `docs` maps a display name → its full text. Pure.
 */
export function checkDocsSync(
  envNames: string[],
  commands: string[],
  docs: Record<string, string>,
): DocsSyncReport {
  const envMissing: Record<string, string[]> = {};
  const cmdMissing: Record<string, string[]> = {};
  for (const [name, corpus] of Object.entries(docs)) {
    const em = missingFromDocs(envNames, corpus);
    const cm = missingFromDocs(commands, corpus);
    if (em.length > 0) envMissing[name] = em;
    if (cm.length > 0) cmdMissing[name] = cm;
  }
  const ok = Object.keys(envMissing).length === 0 && Object.keys(cmdMissing).length === 0;
  return { envMissing, cmdMissing, ok };
}

/** Render the report as human lines. Pure. */
export function renderDocsSync(report: DocsSyncReport): string[] {
  const lines: string[] = [];
  for (const [doc, missing] of Object.entries(report.envMissing)) {
    lines.push(`✗ ${doc}: undocumented env var(s): ${missing.join(", ")}`);
  }
  for (const [doc, missing] of Object.entries(report.cmdMissing)) {
    lines.push(`✗ ${doc}: undocumented command(s): ${missing.join(", ")}`);
  }
  lines.push(report.ok ? "✓ docs in sync — every env flag + command is documented." : "✗ docs drift detected.");
  return lines;
}
