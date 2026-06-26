import { describe, expect, it } from "bun:test";
import { pickTargetFunction } from "../src/context/builder.ts";
import { extractSymbols } from "../src/context/extractor.ts";
import { findDefinitionLines } from "../src/edit/patch-function.ts";

// ---------------------------------------------------------------------------
// Target selection: pick the function that CONTAINS the bug, not a helper whose
// name weakly matches a query token. Regression guard for the mri-flags miss
// (the bug lived in an anonymous `export default function`, but selection aimed
// at the 9-line helper `toVal` because the query said "val").
// ---------------------------------------------------------------------------

// Minimal mri-shaped source: two small named helpers + an anonymous default
// export that is the real parser (and where a "val =" line lives).
const MRI_LIKE = `function toArr(any) {
  return Array.isArray(any) ? any : any == null ? [] : [any];
}

function toVal(out, key, val, opts) {
  out[key] = val;
}

export default function (args, opts) {
  let arr = [];
  let val;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // the buggy lookahead lives here on the val= line
    val = arg.substring(1) || (i + 1 === args.length || args[i + 1].charCodeAt(0) !== 45);
    toVal(arr, arg, val, opts);
  }
  return arr;
}
`;

describe("anonymous export default function extraction", () => {
  it("extracts an anonymous `export default function` as the symbol 'default'", () => {
    const syms = extractSymbols("src/index.js", MRI_LIKE, "javascript");
    const def = syms.find((s) => s.name === "default");
    expect(def).toBeDefined();
    expect(def!.kind).toBe("function");
    // Its body must span the parser (where the val= line is), not a helper.
    expect(def!.line).toBeLessThan(12);
    expect(def!.endLine).toBeGreaterThan(15);
  });
});

describe("pickTargetFunction", () => {
  it("targets the bug-containing default parser, NOT the weakly-named toVal", () => {
    const syms = extractSymbols("src/index.js", MRI_LIKE, "javascript");
    const query =
      "the next-arg lookahead is inverted; fix the single comparison on the val= line in the arg parser";
    expect(pickTargetFunction(syms, MRI_LIKE, query)).toBe("default");
  });

  it("respects an EXACT function-name match in the query", () => {
    const src = `function helper(a) { return a; }
export function wrapText(text, width) {
  const lines = [];
  return lines;
}
`;
    const syms = extractSymbols("src/wrap.ts", src, "typescript");
    // Query names wrapText exactly → must win even though helper is also a fn.
    expect(pickTargetFunction(syms, src, "fix the wrapText width comparison")).toBe("wrapText");
  });

  it("returns undefined when no function has any query signal", () => {
    const src = `function alpha() { return 1; }\nfunction beta() { return 2; }\n`;
    expect(pickTargetFunction(syms_(src), src, "xyzzy quux frobnicate")).toBeUndefined();
  });
});

function syms_(src: string) {
  return extractSymbols("src/x.ts", src, "typescript");
}

describe("findDefinitionLines default anchor", () => {
  it("anchors the 'default' target on the `export default function` line", () => {
    const lines = MRI_LIKE.split("\n");
    const hits = findDefinitionLines(lines, "default");
    expect(hits.length).toBe(1);
    expect(lines[hits[0]!]).toContain("export default function");
  });
});
