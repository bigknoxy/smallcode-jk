import { test, expect, describe } from "bun:test";
import emitter from "../src/index.js";

describe("emitter", () => {
  test("on + emit calls the registered handler with args", () => {
    const e = emitter();
    const calls: unknown[][] = [];
    e.on("greet", (...args: unknown[]) => calls.push(args));
    e.emit("greet", "world", 1);
    expect(calls).toEqual([["world", 1]]);
  });

  test("off removes the exact handler that was registered", () => {
    const e = emitter();
    const calls: string[] = [];
    const handler = () => calls.push("fired");
    e.on("tick", handler);
    e.off("tick", handler);
    e.emit("tick");
    expect(calls).toEqual([]);
  });

  test("off with an unregistered handler does not drop other handlers — the bug", () => {
    // Without a guard on `indexOf` returning -1, `splice(-1, 1)` wrongly
    // removes the LAST registered handler even though it was never the
    // one passed to off().
    const e = emitter();
    const calls: string[] = [];
    const first = () => calls.push("first");
    const second = () => calls.push("second");
    const neverRegistered = () => calls.push("never");

    e.on("tick", first);
    e.on("tick", second);
    e.off("tick", neverRegistered);
    e.emit("tick");

    expect(calls).toEqual(["first", "second"]);
  });

  test("emit on a type with no listeners is a no-op", () => {
    const e = emitter();
    expect(() => e.emit("nothing")).not.toThrow();
  });

  test("multiple handlers for the same type all fire in registration order", () => {
    const e = emitter();
    const calls: string[] = [];
    e.on("multi", () => calls.push("a"));
    e.on("multi", () => calls.push("b"));
    e.on("multi", () => calls.push("c"));
    e.emit("multi");
    expect(calls).toEqual(["a", "b", "c"]);
  });
});
