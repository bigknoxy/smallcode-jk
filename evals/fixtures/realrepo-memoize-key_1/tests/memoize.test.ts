import { test, expect, describe } from "bun:test";
import memoize from "../src/index.js";

describe("memoize", () => {
  test("distinct multi-arg tuples do not collide", () => {
    let calls = 0;
    const add = (a, b) => {
      calls++;
      return a + b;
    };
    const m = memoize(add);

    expect(m(1, 2)).toBe(3);
    expect(m(1, 3)).toBe(4);
    expect(m(1, 2)).toBe(3);
    expect(calls).toBe(2);
  });

  test("identical multi-arg tuples reuse the cached result", () => {
    let calls = 0;
    const mul = (a, b) => {
      calls++;
      return a * b;
    };
    const m = memoize(mul);

    expect(m(2, 3)).toBe(6);
    expect(m(2, 3)).toBe(6);
    expect(m(2, 3)).toBe(6);
    expect(calls).toBe(1);
  });

  test("single-arg memoize caches per distinct argument", () => {
    let calls = 0;
    const square = (a) => {
      calls++;
      return a * a;
    };
    const m = memoize(square);

    expect(m(4)).toBe(16);
    expect(m(5)).toBe(25);
    expect(m(4)).toBe(16);
    expect(calls).toBe(2);
  });

  test("no-arg memoize caches the single call", () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return 42;
    };
    const m = memoize(fn);

    expect(m()).toBe(42);
    expect(m()).toBe(42);
    expect(calls).toBe(1);
  });

  test("three-arg tuples with overlapping prefixes stay distinct", () => {
    let calls = 0;
    const combine = (a, b, c) => {
      calls++;
      return `${a}-${b}-${c}`;
    };
    const m = memoize(combine);

    expect(m(1, 2, 3)).toBe("1-2-3");
    expect(m(1, 2, 4)).toBe("1-2-4");
    expect(m(1, 5, 3)).toBe("1-5-3");
    expect(calls).toBe(3);
  });
});
