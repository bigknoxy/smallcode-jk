import { describe, expect, it } from "bun:test";
import { ollamaUnreachableMessage } from "../src/cli/commands/run.ts";

/**
 * E2-T2 — the human message when Ollama is unreachable before a run. It must
 * name WHERE it tried, WHY it failed, the ONE command that fixes it, and the
 * doctor fallback — never a raw stack trace.
 */
describe("ollamaUnreachableMessage", () => {
  it("names the native URL (strips /v1), the error, the fix, and doctor", () => {
    const msg = ollamaUnreachableMessage("http://localhost:11434/v1", "connect ECONNREFUSED");
    expect(msg).toContain("http://localhost:11434"); // native root, not /v1
    expect(msg).not.toContain("/v1");
    expect(msg).toContain("ECONNREFUSED");
    expect(msg).toContain("ollama serve");
    expect(msg).toContain("smallcode doctor");
  });

  it("omits the parenthetical when no error is supplied", () => {
    const msg = ollamaUnreachableMessage("http://localhost:11434/v1");
    expect(msg).toContain("not reachable");
    expect(msg).not.toContain("()");
  });

  it("honors a custom endpoint", () => {
    const msg = ollamaUnreachableMessage("http://192.168.1.9:11434/v1", "no response within 2000ms");
    expect(msg).toContain("http://192.168.1.9:11434");
    expect(msg).toContain("2000ms");
  });
});
