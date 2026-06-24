/**
 * Self-management commands: update, uninstall.
 *
 * Both commands shell out via Bun.$ for curl/tar/rm so they work on macOS + Linux.
 * The source-resolution logic mirrors install.sh:
 *   1. SMALLCODE_TARBALL env var (local path or URL)
 *   2. Latest GitHub release of bigknoxy/smallcode-jk
 *   3. Fallback: main branch tarball
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ParsedArgs } from "../args.ts";

const REPO = "bigknoxy/smallcode-jk";

// ── helpers ──────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(`[smallcode] ${msg}\n`);
}

function getInstallDir(): string {
  return process.env["SMALLCODE_HOME"] ?? join(process.env["HOME"] ?? "/", ".smallcode");
}

function getBinDir(): string {
  return process.env["SMALLCODE_BIN_DIR"] ?? join(process.env["HOME"] ?? "/", ".local", "bin");
}

async function getInstalledVersionAsync(installDir: string): Promise<string> {
  const pkgPath = join(installDir, "package.json");
  if (!existsSync(pkgPath)) return "none";
  try {
    const raw = await Bun.file(pkgPath).text();
    const match = raw.match(/"version"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function resolveTarballSource(): Promise<string> {
  const envTarball = process.env["SMALLCODE_TARBALL"];
  if (envTarball) return envTarball;

  // Try GitHub API for latest release
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "smallcode-cli" },
    });
    if (resp.ok) {
      const json = (await resp.json()) as { tag_name?: string };
      if (json.tag_name) {
        log(`Found latest release: ${json.tag_name}`);
        return `https://github.com/${REPO}/archive/refs/tags/${json.tag_name}.tar.gz`;
      }
    }
  } catch {
    // network unavailable — fall through
  }

  log("No release found — falling back to main branch");
  return `https://github.com/${REPO}/archive/refs/heads/main.tar.gz`;
}

async function downloadAndInstall(source: string, installDir: string): Promise<void> {
  // Create a temp directory
  const tmpResult = await Bun.$`mktemp -d`.text();
  const tmpDir = tmpResult.trim();
  const tmpTgz = join(tmpDir, "source.tar.gz");

  try {
    // Download or copy
    const isUrl = source.startsWith("http://") || source.startsWith("https://");
    if (isUrl) {
      log(`Downloading: ${source}`);
      await Bun.$`curl -fsSL ${source} -o ${tmpTgz}`;
    } else {
      if (!existsSync(source)) {
        throw new Error(`SMALLCODE_TARBALL path does not exist: ${source}`);
      }
      log(`Using local tarball: ${source}`);
      await Bun.$`cp ${source} ${tmpTgz}`;
    }

    // Extract (strip top-level dir wrapper)
    const extractDir = join(tmpDir, "extracted");
    await Bun.$`mkdir -p ${extractDir}`;
    await Bun.$`tar -xzf ${tmpTgz} -C ${extractDir} --strip-components=1`;

    // Clean + recreate INSTALL_DIR
    log(`Installing to: ${installDir}`);
    await Bun.$`rm -rf ${installDir}`;
    await Bun.$`mkdir -p ${installDir}`;

    // Move extracted contents into installDir
    // Use shell glob to move all files including hidden
    await Bun.$`sh -c "find ${extractDir} -mindepth 1 -maxdepth 1 -exec mv {} ${installDir}/ \\;"`;

    // bun install
    log("Running bun install...");
    try {
      await Bun.$`sh -c "cd ${installDir} && bun install --frozen-lockfile"`;
    } catch {
      await Bun.$`sh -c "cd ${installDir} && bun install"`;
    }
  } finally {
    await Bun.$`rm -rf ${tmpDir}`.catch(() => undefined);
  }
}

// ── update command ────────────────────────────────────────────────────────────

export async function updateCommand(_parsed: ParsedArgs): Promise<void> {
  const installDir = getInstallDir();

  if (!existsSync(installDir)) {
    process.stderr.write(
      `[smallcode] Error: SMALLCODE_HOME not found at ${installDir}.\n` +
        `  Install smallcode first: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh\n`
    );
    process.exit(1);
  }

  const oldVersion = await getInstalledVersionAsync(installDir);
  log(`Current version: ${oldVersion}`);

  const source = await resolveTarballSource();
  await downloadAndInstall(source, installDir);

  const newVersion = await getInstalledVersionAsync(installDir);
  log("");
  log(`  Update complete! ${oldVersion} → ${newVersion}`);
  log("");
}

// ── uninstall command ─────────────────────────────────────────────────────────

export async function uninstallCommand(parsed: ParsedArgs): Promise<void> {
  const installDir = getInstallDir();
  const binDir = getBinDir();
  const wrapperPath = join(binDir, "smallcode");

  const confirmed = parsed.flags["yes"] === true || parsed.flags["y"] === true;

  const targets: string[] = [];
  if (existsSync(installDir)) targets.push(installDir);
  if (existsSync(wrapperPath)) targets.push(wrapperPath);

  if (targets.length === 0) {
    log("Nothing to remove — smallcode does not appear to be installed.");
    return;
  }

  if (!confirmed) {
    process.stdout.write(`[smallcode] Would remove:\n`);
    for (const t of targets) {
      process.stdout.write(`  ${t}\n`);
    }
    process.stdout.write(
      `\nTo confirm, re-run with --yes / -y:\n  smallcode uninstall --yes\n`
    );
    return;
  }

  for (const target of targets) {
    log(`Removing: ${target}`);
    await Bun.$`rm -rf ${target}`;
  }

  log("");
  log("  smallcode has been uninstalled.");
  log("  You may also want to remove the PATH entry for:");
  log(`    ${binDir}`);
  log("");
}
