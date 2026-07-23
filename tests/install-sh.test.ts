import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * E2-T5 — the one-command bootstrap installer. A full run (download + bun install
 * + doctor) is too heavy/environment-dependent for the unit suite (it's covered
 * by a documented live smoke), so here we lock the SCRIPT's contract: it must be
 * valid POSIX sh and carry the bootstrap behaviors it promises.
 */
const SCRIPT = join(import.meta.dir, "..", "install.sh");
const src = readFileSync(SCRIPT, "utf-8");

describe("install.sh", () => {
  it("is valid POSIX sh (`sh -n` parses it)", () => {
    const proc = Bun.spawnSync(["sh", "-n", SCRIPT]);
    expect(proc.exitCode).toBe(0);
  });

  it("gates network/OS actions behind a consent check with --yes / non-interactive auto", () => {
    expect(src).toContain("confirm()");
    expect(src).toMatch(/--yes|SMALLCODE_YES/);
    expect(src).toContain("! -t 0"); // non-interactive (no TTY) proceeds
  });

  it("offers to install bun when missing (not a hard error)", () => {
    expect(src).toContain("Install bun now");
    expect(src).toContain("https://bun.sh/install");
  });

  it("offers to install Ollama when missing, OS-aware", () => {
    expect(src).toContain("Install Ollama now");
    expect(src).toContain("https://ollama.com/install.sh"); // linux path
    expect(src).toMatch(/macOS/); // mac guidance
  });

  it("pulls the recommended default model qwen2.5-coder:3b", () => {
    expect(src).toContain('DEFAULT_MODEL="qwen2.5-coder:3b"');
    expect(src).toContain('ollama pull "$DEFAULT_MODEL"');
  });

  it("finishes by running `smallcode doctor`", () => {
    expect(src).toMatch(/smallcode\.ts" doctor/);
  });

  it("does not reference the stale vibethinker default in the setup guidance", () => {
    // The installer's model guidance should point at the recommended default.
    expect(src).not.toContain("ollama pull weiboai/vibethinker-3b");
  });
});
