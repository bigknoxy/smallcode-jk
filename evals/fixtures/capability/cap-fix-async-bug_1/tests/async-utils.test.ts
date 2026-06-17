import { test, expect } from "bun:test";
import { getDoubledValue } from "../src/async-utils";

test("returns doubled value", async () => {
  const result = await getDoubledValue();
  expect(result).toBe(84);
});

test("returns a number, not a Promise", async () => {
  const result = await getDoubledValue();
  expect(typeof result).toBe("number");
});
