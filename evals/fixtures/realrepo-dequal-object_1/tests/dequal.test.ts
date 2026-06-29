import { test, expect, describe } from "bun:test";
import { dequal } from "../src/index.js";

describe("dequal object key-count", () => {
	test("object with EXTRA keys in bar is NOT equal (bug-catcher)", () => {
		// Bug: the object branch returns `Object.keys(bar).length >= len` instead
		// of `=== len`, so a superset object falsely compares equal.
		// Clean: dequal({a:1}, {a:1,b:2}) === false.
		expect(dequal({ a: 1 }, { a: 1, b: 2 })).toBe(false);
	});

	test("nested object superset is NOT equal (bug-catcher 2)", () => {
		expect(dequal({ a: { x: 1 } }, { a: { x: 1 }, b: 9 })).toBe(false);
	});

	test("identical objects ARE equal (sanity)", () => {
		expect(dequal({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
	});

	test("object missing a key is NOT equal (sanity)", () => {
		expect(dequal({ a: 1, b: 2 }, { a: 1 })).toBe(false);
	});

	test("nested equal objects ARE equal (sanity)", () => {
		expect(dequal({ a: { x: 1 }, b: [1, 2] }, { a: { x: 1 }, b: [1, 2] })).toBe(true);
	});
});
