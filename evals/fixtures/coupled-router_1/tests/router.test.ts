import { expect, test } from "bun:test";
import { handle } from "../src/router.js";

test("existing GET /health route still works", () => {
	expect(handle("GET", "/health")).toBe("ok");
});

test("new POST /submit route works", () => {
	expect(handle("POST", "/submit")).toBe("created");
});
