import { test, expect } from "bun:test";
import { initials } from "../src/initials.ts";
test("basic", () => expect(initials("John Doe")).toBe("JD"));
test("collapses extra spaces", () => expect(initials("John   Doe")).toBe("JD"));
test("single name", () => expect(initials("Madonna")).toBe("M"));
