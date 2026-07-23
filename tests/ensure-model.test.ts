import { describe, expect, it } from "bun:test";
import { ensureModelAvailable } from "../src/models/ensure-model.ts";

/**
 * E2-T3 — auto model-pull policy. Every branch is exercised with injected
 * list/pull/confirm so no live server or real download is touched.
 */

const base = "http://localhost:11434/v1";
const silent = () => {};

describe("ensureModelAvailable", () => {
  it("model already present → ok, no pull, no prompt", async () => {
    let pulled = false;
    let asked = false;
    const res = await ensureModelAvailable(base, "qwen2.5-coder:3b", {
      yes: false,
      interactive: true,
      listModels: async () => ["qwen2.5-coder:3b"],
      pull: async () => ((pulled = true), { ok: true }),
      confirm: async () => ((asked = true), true),
      log: silent,
    });
    expect(res.ok).toBe(true);
    expect(res.action).toBe("present");
    expect(pulled).toBe(false);
    expect(asked).toBe(false);
  });

  it("missing + --yes → auto-pulls without asking", async () => {
    let asked = false;
    const res = await ensureModelAvailable(base, "qwen2.5-coder:3b", {
      yes: true,
      interactive: false,
      listModels: async () => [],
      pull: async (id) => (id === "qwen2.5-coder:3b" ? { ok: true } : { ok: false }),
      confirm: async () => ((asked = true), true),
      log: silent,
    });
    expect(res.ok).toBe(true);
    expect(res.action).toBe("pulled");
    expect(asked).toBe(false); // --yes never prompts
  });

  it("missing + interactive + user says yes → pulls", async () => {
    const res = await ensureModelAvailable(base, "gemma4:12b", {
      yes: false,
      interactive: true,
      listModels: async () => ["qwen2.5-coder:3b"],
      confirm: async () => true,
      pull: async () => ({ ok: true }),
      log: silent,
    });
    expect(res.ok).toBe(true);
    expect(res.action).toBe("pulled");
  });

  it("missing + interactive + user says no → blocked with the pull hint", async () => {
    let pulled = false;
    const res = await ensureModelAvailable(base, "gemma4:12b", {
      yes: false,
      interactive: true,
      listModels: async () => [],
      confirm: async () => false,
      pull: async () => ((pulled = true), { ok: true }),
      log: silent,
    });
    expect(res.ok).toBe(false);
    expect(res.action).toBe("declined");
    expect(res.message).toContain("ollama pull gemma4:12b");
    expect(pulled).toBe(false);
  });

  it("missing + non-interactive + no --yes → NEVER pulls silently, blocks", async () => {
    let pulled = false;
    const res = await ensureModelAvailable(base, "qwen2.5-coder:7b", {
      yes: false,
      interactive: false,
      listModels: async () => [],
      pull: async () => ((pulled = true), { ok: true }),
      log: silent,
    });
    expect(res.ok).toBe(false);
    expect(res.action).toBe("blocked-noninteractive");
    expect(res.message).toContain("ollama pull qwen2.5-coder:7b");
    expect(res.message).toContain("--yes");
    expect(pulled).toBe(false);
  });

  it("pull fails → not ok, surfaces the error + manual hint", async () => {
    const res = await ensureModelAvailable(base, "qwen2.5-coder:7b", {
      yes: true,
      interactive: false,
      listModels: async () => [],
      pull: async () => ({ ok: false, error: "network unreachable" }),
      log: silent,
    });
    expect(res.ok).toBe(false);
    expect(res.action).toBe("pull-failed");
    expect(res.message).toContain("network unreachable");
    expect(res.message).toContain("ollama pull qwen2.5-coder:7b");
  });

  it("a bare id matches an installed :latest tag → present", async () => {
    const res = await ensureModelAvailable(base, "nomic-embed-text", {
      yes: false,
      interactive: false,
      listModels: async () => ["nomic-embed-text:latest"],
      log: silent,
    });
    expect(res.ok).toBe(true);
    expect(res.action).toBe("present");
  });
});
