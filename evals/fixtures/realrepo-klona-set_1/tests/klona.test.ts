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

  test("clones nested Set elements by value, not by reference", () => {
    const inner = { n: 1 };
    const a = { s: new Set([inner]) };
    const b = klona(a);
    expect(b.s).not.toBe(a.s);
    const [bElem] = b.s;
    const [aElem] = a.s;
    // The shared-ref bug: cloned element IS the same object as the original
    expect(bElem).not.toBe(aElem);
    // Mutating the cloned element must not affect the original
    bElem.n = 99;
    expect(aElem.n).toBe(1);
  });
});
