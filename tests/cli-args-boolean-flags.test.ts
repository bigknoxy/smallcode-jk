/**
 * Boolean flags must NOT swallow the following positional.
 *
 * `parseArgs` has no flag schema, so for `--flag value` it guesses: it treats the
 * next token as the flag's value unless that token looks like another flag. That
 * guess is WRONG for genuinely boolean flags placed before positionals:
 *
 *   smallcode run --json improve the parser
 *
 * `--json` is a boolean, but the parser captures `flags.json = "improve"` and
 * drops "improve" from the task — so `--json` is silently ignored (flagBool sees
 * a non-"true" string) AND the task text is corrupted. The fix: the known boolean
 * flags (`--json`, `--yes`) are always boolean and never consume the next token.
 */

import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args.ts";

describe("parseArgs — boolean flags do not consume the next positional", () => {
  it("--json before a task keeps the whole task and sets json=true", () => {
    const r = parseArgs(["run", "--json", "improve", "the", "parser"]);
    expect(r.command).toBe("run");
    expect(r.positionals).toEqual(["improve", "the", "parser"]);
    expect(r.flags["json"]).toBe(true);
  });

  it("--yes before a task is boolean, not a value", () => {
    const r = parseArgs(["run", "--yes", "fix", "it"]);
    expect(r.positionals).toEqual(["fix", "it"]);
    expect(r.flags["yes"]).toBe(true);
  });

  it("a boolean flag mixed with a value flag parses both correctly", () => {
    const r = parseArgs(["fix", "--yes", "--repo", "/tmp/x"]);
    expect(r.flags["yes"]).toBe(true);
    expect(r.flags["repo"]).toBe("/tmp/x");
  });

  // Regression guards: value flags MUST still consume their argument.
  it("value flag --model still consumes its argument", () => {
    const r = parseArgs(["run", "--model", "qwen2.5-coder:7b", "do", "x"]);
    expect(r.flags["model"]).toBe("qwen2.5-coder:7b");
    expect(r.positionals).toEqual(["do", "x"]);
  });

  it("--json=1 explicit form is unaffected", () => {
    const r = parseArgs(["run", "--json=1", "task"]);
    expect(r.flags["json"]).toBe("1");
    expect(r.positionals).toEqual(["task"]);
  });
});
