import { test, expect } from "bun:test";
import { EventEmitter } from "../src/event-emitter";

test("on and emit calls listener", () => {
  const ee = new EventEmitter();
  let called = false;
  ee.on("foo", () => { called = true; });
  ee.emit("foo");
  expect(called).toBe(true);
});

test("emit passes arguments to listener", () => {
  const ee = new EventEmitter();
  let received: unknown[] = [];
  ee.on("data", (...args: unknown[]) => { received = args; });
  ee.emit("data", 1, "hello");
  expect(received).toEqual([1, "hello"]);
});

test("multiple listeners on same event", () => {
  const ee = new EventEmitter();
  let count = 0;
  ee.on("tick", () => count++);
  ee.on("tick", () => count++);
  ee.emit("tick");
  expect(count).toBe(2);
});

test("off removes listener", () => {
  const ee = new EventEmitter();
  let count = 0;
  const fn = () => count++;
  ee.on("x", fn);
  ee.off("x", fn);
  ee.emit("x");
  expect(count).toBe(0);
});

test("emit unknown event does nothing", () => {
  const ee = new EventEmitter();
  expect(() => ee.emit("unknown")).not.toThrow();
});

test("off non-registered listener does nothing", () => {
  const ee = new EventEmitter();
  expect(() => ee.off("x", () => {})).not.toThrow();
});
