import { dset } from "../src/index.js";
import { test, expect, describe } from "bun:test";

describe("dset", () => {
  test("deep nested set (bug-catcher)", () => {
    const o = {};
    dset(o, "a.b.c", 5);
    expect(o).toEqual({ a: { b: { c: 5 } } });
  });

  test("single key (sanity)", () => {
    const o2 = {};
    dset(o2, "x", 1);
    expect(o2).toEqual({ x: 1 });
  });

  test("two-level (bug-catcher 2)", () => {
    const o3 = {};
    dset(o3, "p.q", 7);
    expect(o3).toEqual({ p: { q: 7 } });
  });

  test("overwrite existing (sanity)", () => {
    const o4 = { a: { b: 1 } };
    dset(o4, "a.b", 2);
    expect(o4.a.b).toBe(2);
  });
});
