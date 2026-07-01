/** Run git, capturing combined stdout+stderr. ok = exit 0. */
export function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  const out =
    (p.stdout instanceof Uint8Array ? new TextDecoder().decode(p.stdout) : "") +
    (p.stderr instanceof Uint8Array ? new TextDecoder().decode(p.stderr) : "");
  return { ok: (p.exitCode ?? 1) === 0, out };
}

/** True when `cwd` is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  return git(["rev-parse", "--git-dir"], cwd).ok;
}
