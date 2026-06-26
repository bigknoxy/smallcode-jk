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

  test("clones array preserving all elements including index 0", () => {
    const a = { arr: [1, 2, 3] };
    const b = klona(a);
    expect(b.arr).not.toBe(a.arr);
    expect(b.arr).toEqual([1, 2, 3]);
    expect(b.arr.length).toBe(3);
    // The --k bug drops index 0 (loop stops before k===0)
    expect(b.arr[0]).toBe(1);
    expect(b.arr[1]).toBe(2);
    expect(b.arr[2]).toBe(3);
  });
});
