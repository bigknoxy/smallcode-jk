import { describe, expect, it } from "bun:test";
import { surfaceCoupledDecls } from "@/context/coupled-decls.ts";
import type { CodeSymbol } from "@/context/types.ts";

describe("surfaceCoupledDecls", () => {
  it("(a) surfaces a module const the fn references", () => {
    const content = [
      /* 1 */ "const KINDS = new Set([\"add\", \"sub\"]);",
      /* 2 */ "export function applyOp(kind, a, b) {",
      /* 3 */ "\tif (!KINDS.has(kind)) throw new Error(\"unknown kind\");",
      /* 4 */ "\treturn a + b;",
      /* 5 */ "}",
    ].join("\n");
    const symbols: CodeSymbol[] = [
      { name: "applyOp", kind: "function", line: 2, endLine: 5 },
    ];
    const result = surfaceCoupledDecls(content, symbols, "applyOp");
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("KINDS");
    expect(result[0]?.startLine).toBe(1);
  });

  it("(b) ignores a module const the fn does NOT reference", () => {
    const content = [
      /* 1 */ "const UNUSED = 42;",
      /* 2 */ "export function applyOp(kind, a, b) {",
      /* 3 */ "\treturn a + b;",
      /* 4 */ "}",
    ].join("\n");
    const symbols: CodeSymbol[] = [
      { name: "applyOp", kind: "function", line: 2, endLine: 4 },
    ];
    const result = surfaceCoupledDecls(content, symbols, "applyOp");
    expect(result).toHaveLength(0);
  });

  it("(c) ignores a const declared INSIDE the fn body (local, not module-level)", () => {
    const content = [
      /* 1 */ "export function applyOp(kind, a, b) {",
      /* 2 */ "\tconst LOCAL = a + b;",
      /* 3 */ "\treturn LOCAL;",
      /* 4 */ "}",
    ].join("\n");
    const symbols: CodeSymbol[] = [
      { name: "applyOp", kind: "function", line: 1, endLine: 4 },
    ];
    const result = surfaceCoupledDecls(content, symbols, "applyOp");
    expect(result).toHaveLength(0);
  });

  it("(d) undefined targetFnName returns []", () => {
    const content = [
      /* 1 */ "const KINDS = new Set([\"add\"]);",
      /* 2 */ "export function applyOp(kind, a, b) {",
      /* 3 */ "\treturn KINDS.has(kind);",
      /* 4 */ "}",
    ].join("\n");
    const symbols: CodeSymbol[] = [
      { name: "applyOp", kind: "function", line: 2, endLine: 4 },
    ];
    const result = surfaceCoupledDecls(content, symbols, undefined);
    expect(result).toEqual([]);
  });

  it("(e) a fn referencing TWO module consts → BOTH surfaced (FLIPS + OP_RE shape)", () => {
    const content = [
      /* 1 */ "const FLIPS = { \"+\": \"-\", \"-\": \"+\" };",
      /* 2 */ "const OP_RE = /\\+|-/g;",
      /* 3 */ "export function mutateOps(src) {",
      /* 4 */ "\tconst out = [];",
      /* 5 */ "\tfor (const m of src.matchAll(OP_RE)) {",
      /* 6 */ "\t\tconst to = FLIPS[m[0]];",
      /* 7 */ "\t\tif (to === undefined) continue;",
      /* 8 */ "\t\tout.push(to);",
      /* 9 */ "\t}",
      /* 10 */ "\treturn out;",
      /* 11 */ "}",
    ].join("\n");
    const symbols: CodeSymbol[] = [
      { name: "mutateOps", kind: "function", line: 3, endLine: 11 },
    ];
    const result = surfaceCoupledDecls(content, symbols, "mutateOps");
    const names = result.map((d) => d.name).sort();
    expect(names).toEqual(["FLIPS", "OP_RE"]);
  });
});
