import { expect, test } from "bun:test";
import { withTax } from "../src/index.js";

// withTax must add 8% sales tax and round to the nearest cent.
test("adds 8% tax to a round amount", () => {
	expect(withTax(1000)).toBe(1080);
});

test("adds 8% tax and rounds", () => {
	expect(withTax(250)).toBe(270);
});
