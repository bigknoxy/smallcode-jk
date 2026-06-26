import { test, expect, describe } from "bun:test";
import { klona } from "../src/index.js";

describe("klona", () => {
  test("clones nested objects without sharing references", () => {
    const a = { x: { y: 1 } };
    const b = klona(a);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(b.x).not.toBe(a.x);
    b.x.y = 99;
    expect(a.x.y).toBe(1);
  });

  test("clones arrays preserving order and not sharing refs", () => {
    const a = [1, [2, 3], { n: 4 }];
    const b = klona(a);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(b[1]).not.toBe(a[1]);
    (b[1] as number[])[0] = 99;
    expect((a[1] as number[])[0]).toBe(2);
  });

  test("clones Map entries by value", () => {
    const inner = { v: 1 };
    const a = new Map<string, typeof inner>([["k", inner]]);
    const b = klona(a);
    expect(b).not.toBe(a);
    expect(b.get("k")).toEqual(inner);
    expect(b.get("k")).not.toBe(inner);
  });

  test("clones Set entries by value", () => {
    const inner = { v: 1 };
    const a = new Set([inner]);
    const b = klona(a);
    expect(b).not.toBe(a);
    const [bVal] = b;
    expect(bVal).toEqual(inner);
    expect(bVal).not.toBe(inner);
  });

  test("clones RegExp preserving source and flags", () => {
    const a = /hello/gi;
    const b = klona(a);
    expect(b).not.toBe(a);
    expect(b.source).toBe(a.source);
    expect(b.flags).toBe(a.flags);
  });

  test("clones Date by value, not reference", () => {
    const a = { d: new Date(2020, 0, 1) };
    const b = klona(a);
    expect(b.d).not.toBe(a.d);
    expect(b.d.getTime()).toBe(a.d.getTime());
    b.d.setFullYear(1999);
    expect(a.d.getFullYear()).toBe(2020);
  });
});
