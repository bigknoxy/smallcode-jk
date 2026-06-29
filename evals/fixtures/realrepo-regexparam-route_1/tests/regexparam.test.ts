import { parse } from "../src/index.js";
import { test, expect, describe } from "bun:test";

describe("regexparam parse", () => {
	test("static route matches correctly (bug-catcher)", () => {
		const r = parse("/foo/bar");
		expect(r.pattern.test("/foo/bar")).toBe(true);
		expect(r.keys).toEqual([]);
	});

	test("static route does not match wrong path (sanity)", () => {
		expect(parse("/foo/bar").pattern.test("/foo/baz")).toBe(false);
	});

	test("named param extracts value (sanity, unaffected by bug)", () => {
		const r2 = parse("/users/:id");
		expect(r2.keys).toEqual(["id"]);
		const m = r2.pattern.exec("/users/123");
		expect(m && m[1]).toBe("123");
	});

	test("single static segment matches (bug-catcher 2)", () => {
		expect(parse("/books").pattern.test("/books")).toBe(true);
	});
});
