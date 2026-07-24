import { describe, expect, it } from "bun:test";
import {
  checkDocsSync,
  extractCommands,
  missingFromDocs,
  renderDocsSync,
} from "../src/eval/docs-sync.ts";

/**
 * E5-T3 — docs-drift check. Enforces the HARD no-drift rule for the structured
 * surfaces (SMALLCODE_* flags + CLI commands): each must appear verbatim in the
 * public docs, or the check fails.
 */
describe("missingFromDocs", () => {
  it("returns tokens absent from the corpus", () => {
    expect(missingFromDocs(["A", "B", "C"], "text with A and C")).toEqual(["B"]);
    expect(missingFromDocs(["A"], "has A")).toEqual([]);
  });
});

describe("extractCommands", () => {
  it("pulls `case \"<cmd>\":` names from the dispatch source", () => {
    const src = `
      switch (cmd) {
        case "run": break;
        case "doctor": break;
        case "config-init": break;   // hyphenated ok
        default: break;
      }`;
    expect(extractCommands(src).sort()).toEqual(["config-init", "doctor", "run"]);
  });
});

describe("checkDocsSync", () => {
  const envNames = ["SMALLCODE_FOO", "SMALLCODE_BAR"];
  const commands = ["run", "doctor"];

  it("ok when every flag + command appears in every doc", () => {
    const docs = {
      "README.md": "flags SMALLCODE_FOO SMALLCODE_BAR; commands run doctor",
      "llms.html": "SMALLCODE_FOO SMALLCODE_BAR run doctor",
    };
    const r = checkDocsSync(envNames, commands, docs);
    expect(r.ok).toBe(true);
    expect(renderDocsSync(r).some((l) => l.includes("in sync"))).toBe(true);
  });

  it("flags an env var documented in code but missing from a doc", () => {
    const docs = {
      "README.md": "SMALLCODE_FOO run doctor", // BAR missing
      "llms.html": "SMALLCODE_FOO SMALLCODE_BAR run doctor",
    };
    const r = checkDocsSync(envNames, commands, docs);
    expect(r.ok).toBe(false);
    expect(r.envMissing["README.md"]).toEqual(["SMALLCODE_BAR"]);
    expect(renderDocsSync(r).some((l) => l.includes("undocumented env var(s): SMALLCODE_BAR"))).toBe(true);
  });

  it("flags an undocumented command", () => {
    const docs = {
      "README.md": "SMALLCODE_FOO SMALLCODE_BAR run", // doctor missing
      "llms.html": "SMALLCODE_FOO SMALLCODE_BAR run doctor",
    };
    const r = checkDocsSync(envNames, commands, docs);
    expect(r.ok).toBe(false);
    expect(r.cmdMissing["README.md"]).toEqual(["doctor"]);
  });
});
