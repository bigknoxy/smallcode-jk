import { test, expect } from "bun:test";
import { enumerateComparisonMutations } from "../src/operator-mutation.ts";

// Existing behavior must keep working: comparison + arithmetic +/- flips.
test("still enumerates existing operator flips", () => {
  const { mutations } = enumerateComparisonMutations("a === b");
  expect(mutations.some((m) => m.label === "=== -> !==")).toBe(true);
});

// New requirement: the enumerator must also propose multiplication/division
// flips, so a wrong `*`/`/` operator bug can be repaired.
test("enumerates * -> / flip", () => {
  const { mutations } = enumerateComparisonMutations("const y = a * b;");
  const flip = mutations.find((m) => m.label === "* -> /");
  expect(flip).toBeDefined();
  expect(flip?.candidate).toBe("const y = a / b;");
});

test("enumerates / -> * flip", () => {
  const { mutations } = enumerateComparisonMutations("const y = a / b;");
  const flip = mutations.find((m) => m.label === "/ -> *");
  expect(flip).toBeDefined();
  expect(flip?.candidate).toBe("const y = a * b;");
});
