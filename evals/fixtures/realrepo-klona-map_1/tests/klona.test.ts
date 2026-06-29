import { test, expect, describe } from "bun:test";
import { klona } from "../src/index.js";

describe("klona Map deep-clone", () => {
	test("Map values are DEEP-cloned, not shared by reference (bug-catcher)", () => {
		// Bug: the Map branch does `tmp.set(klona(key), val)` — the value is copied
		// by reference instead of `klona(val)`, so mutating the clone's value
		// mutates the original. Clean: the clone is fully independent.
		const orig = new Map([["a", { n: 1 }]]);
		const copy = klona(orig);
		copy.get("a").n = 999;
		expect(orig.get("a").n).toBe(1);
	});

	test("Map nested array values are cloned independently (bug-catcher 2)", () => {
		const orig = new Map([["list", [1, 2, 3]]]);
		const copy = klona(orig);
		copy.get("list").push(4);
		expect(orig.get("list")).toEqual([1, 2, 3]);
	});

	test("Map structure is preserved (sanity)", () => {
		const orig = new Map([["a", { n: 1 }], ["b", { n: 2 }]]);
		const copy = klona(orig);
		expect(copy instanceof Map).toBe(true);
		expect(copy.size).toBe(2);
		expect(copy.get("a")).toEqual({ n: 1 });
		expect(copy.get("b")).toEqual({ n: 2 });
	});

	test("primitive Map values still copy correctly (sanity)", () => {
		const orig = new Map([["x", 10], ["y", 20]]);
		const copy = klona(orig);
		expect(copy.get("x")).toBe(10);
		expect(copy.get("y")).toBe(20);
	});
});
