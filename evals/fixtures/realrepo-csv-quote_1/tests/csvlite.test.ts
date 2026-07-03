import { test, expect, describe } from "bun:test";
import parse from "../src/index.js";

describe("csvlite", () => {
  test("plain fields with no quoting", () => {
    expect(parse("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  test("comma inside a quoted field is not treated as a separator", () => {
    expect(parse('"x,y",z')).toEqual([["x,y", "z"]]);
  });

  test("trailing empty field after a comma", () => {
    expect(parse("a,b,")).toEqual([["a", "b", ""]]);
  });

  test("multi-line input parses each line independently", () => {
    expect(parse('a,b\n"x,y",z')).toEqual([
      ["a", "b"],
      ["x,y", "z"],
    ]);
  });

  test("escaped double-quote inside a quoted field decodes to a literal quote — the bug", () => {
    // RFC-4180: "" inside a quoted field means a literal ". Without
    // handling the escape, the scanner closes the field early on the
    // first `"` of the pair and mis-splits the rest of the line.
    expect(parse('"she said ""hi"""')).toEqual([['she said "hi"']]);
  });
});
