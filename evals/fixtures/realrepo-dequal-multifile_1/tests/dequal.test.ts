import { test, expect, describe } from "bun:test";
import { dequal } from "../src/index.js";

describe("dequal", () => {
  test("equal primitives", () => {
    expect(dequal(1, 1)).toBe(true);
    expect(dequal("abc", "abc")).toBe(true);
    expect(dequal(null, null)).toBe(true);
    expect(dequal(undefined, undefined)).toBe(true);
  });

  test("unequal primitives", () => {
    expect(dequal(1, 2)).toBe(false);
    expect(dequal("a", "b")).toBe(false);
    expect(dequal(null, undefined)).toBe(false);
  });

  test("equal flat arrays", () => {
    expect(dequal([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  test("arrays of different length wrongly report equal — the bug", () => {
    // [1, 2] is a prefix of [1, 2, 3]; without the length guard the shorter
    // array iterates to len=-1 and incorrectly returns true.
    expect(dequal([1, 2], [1, 2, 3])).toBe(false);
    expect(dequal([1, 2, 3], [1, 2])).toBe(false);
    expect(dequal([], [1])).toBe(false);
    expect(dequal([1], [])).toBe(false);
  });

  test("equal nested arrays", () => {
    expect(dequal([1, [2, 3]], [1, [2, 3]])).toBe(true);
  });

  test("equal plain objects", () => {
    expect(dequal({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  test("unequal plain objects", () => {
    expect(dequal({ a: 1 }, { a: 2 })).toBe(false);
    expect(dequal({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  test("equal Date objects", () => {
    expect(dequal(new Date(2020, 0, 1), new Date(2020, 0, 1))).toBe(true);
  });

  test("unequal Date objects", () => {
    expect(dequal(new Date(2020, 0, 1), new Date(2021, 0, 1))).toBe(false);
  });

  test("equal RegExp", () => {
    expect(dequal(/abc/gi, /abc/gi)).toBe(true);
  });

  test("unequal RegExp", () => {
    expect(dequal(/abc/, /xyz/)).toBe(false);
  });

  test("equal Set", () => {
    expect(dequal(new Set([1, 2, 3]), new Set([1, 2, 3]))).toBe(true);
  });

  test("unequal Set", () => {
    expect(dequal(new Set([1, 2]), new Set([1, 2, 3]))).toBe(false);
  });

  test("equal Map", () => {
    expect(dequal(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
  });

  test("unequal Map", () => {
    expect(dequal(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
  });
});
