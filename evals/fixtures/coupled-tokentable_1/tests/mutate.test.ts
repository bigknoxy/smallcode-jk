import { expect, test } from "bun:test";
import { mutateOps } from "../src/mutate.js";

test("flips + to -", () => {
	expect(mutateOps("a + b")).toEqual(["a - b"]);
});

test("flips - to +", () => {
	expect(mutateOps("a - b")).toEqual(["a + b"]);
});

test("flips * to /", () => {
	expect(mutateOps("a * b")).toEqual(["a / b"]);
});

test("flips / to *", () => {
	expect(mutateOps("a / b")).toEqual(["a * b"]);
});
