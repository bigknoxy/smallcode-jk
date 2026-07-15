import { expect, test } from "bun:test";
import { applyOp } from "../src/apply.js";

test("add works", () => {
	expect(applyOp("add", 3, 4)).toBe(7);
});

test("sub works", () => {
	expect(applyOp("sub", 3, 4)).toBe(-1);
});

test("mul works", () => {
	expect(applyOp("mul", 3, 4)).toBe(12);
});
