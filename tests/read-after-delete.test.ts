import { describe, expect, it } from "bun:test";
import {
  detectReadAfterDelete,
  repairReadAfterDelete,
} from "../src/repair/read-after-delete.ts";

const CANONICAL = `function get(key) {
  if (map.has(key)) {
    map.delete(key);
    map.set(key, map.get(key));
  }
  return map.get(key);
}
`;

const CORRECT = `function get(key) {
  if (map.has(key)) {
    const val = map.get(key);
    map.delete(key);
    map.set(key, val);
  }
  return map.get(key);
}
`;

describe("detectReadAfterDelete", () => {
  it("flags the canonical get() read-after-delete bug exactly once", () => {
    const findings = detectReadAfterDelete(CANONICAL);
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.object).toBe("map");
    expect(f.key).toBe("key");
    expect(f.deleteLine).toBe(3);
    expect(f.setLine).toBe(4);
    expect(f.hint).toContain("const val");
    expect(f.hint).toContain("map.delete(key)");
    expect(f.hint).toContain("map.get(key)");
  });

  it("does NOT flag the correct temp-before-delete version", () => {
    expect(detectReadAfterDelete(CORRECT)).toEqual([]);
  });

  it("does NOT flag a plain `return map.get(key)` with no delete", () => {
    const src = `function peek(key) {\n  return map.get(key);\n}\n`;
    expect(detectReadAfterDelete(src)).toEqual([]);
  });

  it("does NOT flag a set whose argument is not a get after delete", () => {
    const src = `function touch(key, val) {\n  map.delete(key);\n  map.set(key, val);\n}\n`;
    expect(detectReadAfterDelete(src)).toEqual([]);
  });

  it("does NOT flag when a correct re-set intervenes before a later bad set", () => {
    const src = `map.delete(key);\nmap.set(key, computed);\nmap.set(key, map.get(key));\n`;
    // The intervening correct `map.set(key, computed)` restores the value, so the
    // later `map.set(key, map.get(key))` reads a live entry — not the bug.
    expect(detectReadAfterDelete(src)).toEqual([]);
  });

  it("handles a different object and key (cache/id)", () => {
    const src = `function get(id) {\n  cache.delete(id);\n  cache.set(id, cache.get(id));\n}\n`;
    const findings = detectReadAfterDelete(src);
    expect(findings.length).toBe(1);
    expect(findings[0]!.object).toBe("cache");
    expect(findings[0]!.key).toBe("id");
  });

  it("matches a dotted key expression across whitespace variation", () => {
    const src = `store.delete(opts.key);\nstore.set(opts.key, store.get(opts . key));\n`;
    const findings = detectReadAfterDelete(src);
    expect(findings.length).toBe(1);
    expect(findings[0]!.object).toBe("store");
    expect(findings[0]!.key).toBe("opts.key");
  });
});

describe("repairReadAfterDelete", () => {
  it("hoists the read into a temp before the delete for the canonical bug", () => {
    const repair = repairReadAfterDelete(CANONICAL);
    expect(repair).not.toBeNull();
    expect(repair!.label).toBe("read-after-delete hoist");
    expect(repair!.line).toBe(3);
    // The temp-before-delete form is produced...
    expect(repair!.candidate).toContain("const __radVal = map.get(key);");
    expect(repair!.candidate).toContain("map.set(key, __radVal)");
    // ...and applying it removes the finding entirely.
    expect(detectReadAfterDelete(repair!.candidate)).toEqual([]);
  });

  it("preserves indentation and untouched lines", () => {
    const repair = repairReadAfterDelete(CANONICAL)!;
    expect(repair.candidate).toContain("    const __radVal = map.get(key);\n    map.delete(key);");
    // The trailing `return map.get(key);` is untouched.
    expect(repair.candidate).toContain("  return map.get(key);");
  });

  it("returns null for already-correct source (no finding)", () => {
    expect(repairReadAfterDelete(CORRECT)).toBeNull();
  });

  it("returns null when two independent findings are ambiguous", () => {
    const src =
      `map.delete(a);\nmap.set(a, map.get(a));\n` +
      `cache.delete(b);\ncache.set(b, cache.get(b));\n`;
    expect(detectReadAfterDelete(src).length).toBe(2);
    expect(repairReadAfterDelete(src)).toBeNull();
  });

  it("falls back to __radVal2 when __radVal already appears in source", () => {
    const src = `let __radVal = 1;\nmap.delete(key);\nmap.set(key, map.get(key));\n`;
    const repair = repairReadAfterDelete(src)!;
    expect(repair).not.toBeNull();
    expect(repair.candidate).toContain("const __radVal2 = map.get(key);");
    expect(repair.candidate).toContain("map.set(key, __radVal2)");
    // Original __radVal declaration untouched.
    expect(repair.candidate).toContain("let __radVal = 1;");
    expect(detectReadAfterDelete(repair.candidate)).toEqual([]);
  });
});
