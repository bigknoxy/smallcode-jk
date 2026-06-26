import { test, expect, describe } from "bun:test";
import { klona } from "../src/index.js";

describe("klona", () => {
  test("sanity: clones a basic object without sharing references", () => {
    const a = { x: { y: 1 } };
    const b = klona(a);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(b.x).not.toBe(a.x);
    b.x.y = 99;
    expect(a.x.y).toBe(1);
  });

  test("clones RegExp preserving source, flags, and lastIndex", () => {
    const r = /x/g;
    r.lastIndex = 2;
    const b = klona(r);
    expect(b).not.toBe(r);
    expect(b.source).toBe(r.source);
    expect(b.flags).toBe(r.flags);
    // Missing `tmp.lastIndex = x.lastIndex` causes this to fail
    expect(b.lastIndex).toBe(2);
  });
});
