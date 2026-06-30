import { test, expect, describe } from "bun:test";
import { buildEscalationLadder } from "../src/agent/escalation.ts";

// Pure ladder-construction tests (no loop mock — runBestOfNLoop escalation
// behaviour is covered in bestofn-loop.test.ts alongside the existing mock).
describe("R1 buildEscalationLadder", () => {
  const registry = { get: (id: string) => ({ id }) } as any;
  const provider = { name: "ollama" } as any;

  test("parses a comma spec into rungs (cheapest first), reusing the base provider", () => {
    const ladder = buildEscalationLadder({
      spec: "qwen2.5-coder:3b, qwen2.5-coder:3b ,qwen2.5-coder:7b",
      registry,
      provider,
    });
    expect(ladder?.map((r) => r.id)).toEqual([
      "qwen2.5-coder:3b",
      "qwen2.5-coder:3b",
      "qwen2.5-coder:7b",
    ]);
    expect(ladder?.every((r) => r.provider === provider)).toBe(true);
    expect(ladder?.map((r) => r.profile.id)).toEqual([
      "qwen2.5-coder:3b",
      "qwen2.5-coder:3b",
      "qwen2.5-coder:7b",
    ]);
  });

  test("unset / empty spec → undefined (no escalation)", () => {
    expect(buildEscalationLadder({ spec: undefined, registry, provider })).toBeUndefined();
    expect(buildEscalationLadder({ spec: "  , ,", registry, provider })).toBeUndefined();
  });

  test("unknown id throws via registry.get (clear config error)", () => {
    const strict = {
      get: (id: string) => {
        if (id === "nope") throw new Error("unknown model");
        return { id };
      },
    } as any;
    expect(() => buildEscalationLadder({ spec: "nope", registry: strict, provider })).toThrow();
  });
});
