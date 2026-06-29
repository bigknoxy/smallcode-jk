import clsx from "../src/index.js";
import { test, expect, describe } from "bun:test";

describe("clsx", () => {
	test("object: includes only truthy-value keys (bug-catcher)", () => {
		expect(clsx({ a: 1, b: 0, c: 1, d: false, e: true })).toBe("a c e");
	});

	test("strings: basic concatenation (sanity)", () => {
		expect(clsx("foo", "bar")).toBe("foo bar");
	});

	test("array: skips falsy entries (array branch sanity)", () => {
		expect(clsx(["x", 0, "y"])).toBe("x y");
	});

	test("object: on=true off=false yields only 'on' (bug-catcher 2)", () => {
		expect(clsx({ on: true, off: false })).toBe("on");
	});
});
