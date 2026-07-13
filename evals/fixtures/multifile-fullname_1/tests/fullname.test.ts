import { expect, test } from "bun:test";
import { fullName } from "../src/index.js";

// fullName must join first and last with a single space.
test("joins first and last with a space", () => {
	expect(fullName("Ada", "Lovelace")).toBe("Ada Lovelace");
});

test("works for another name", () => {
	expect(fullName("Grace", "Hopper")).toBe("Grace Hopper");
});
