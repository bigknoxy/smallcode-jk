import { test, expect, describe } from "bun:test";
import toposort from "../src/index.js";

describe("toposort", () => {
  test("diamond dependency graph orders dependencies before dependents", () => {
    // a depends on b and c; b and c both depend on d.
    var order = toposort([["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]);
    var idx = (n: string) => order.indexOf(n);

    expect(idx("d")).toBeGreaterThanOrEqual(0);
    expect(idx("d")).toBeLessThan(idx("b"));
    expect(idx("d")).toBeLessThan(idx("c"));
    expect(idx("b")).toBeLessThan(idx("a"));
    expect(idx("c")).toBeLessThan(idx("a"));
  });

  test("linear chain preserves dependency order", () => {
    var order = toposort([["a", "b"], ["b", "c"], ["c", "d"]]);
    expect(order.indexOf("d")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
  });

  test("two independent roots sharing a dependency both come after it", () => {
    var order = toposort([["x", "shared"], ["y", "shared"]]);
    var idx = (n: string) => order.indexOf(n);
    expect(idx("shared")).toBeLessThan(idx("x"));
    expect(idx("shared")).toBeLessThan(idx("y"));
  });

  test("single edge orders dependency first", () => {
    var order = toposort([["a", "b"]]);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
  });

  test("result contains every node exactly once", () => {
    var order = toposort([["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]);
    expect(order.length).toBe(4);
    expect(new Set(order).size).toBe(4);
  });
});
