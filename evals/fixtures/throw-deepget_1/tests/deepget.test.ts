import { test, expect } from "bun:test";
import { deepGet } from "../src/deepget.ts";
const o = { a: { b: { c: 42 } } };
test("resolves a present path", () => expect(deepGet(o, "a.b.c")).toBe(42));
test("missing leaf is undefined", () => expect(deepGet(o, "a.b.x")).toBeUndefined());
test("missing mid path is undefined, does not throw", () => expect(deepGet(o, "a.z.c")).toBeUndefined());
