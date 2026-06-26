import { test, expect, describe } from "bun:test";
import { parse } from "../src/parser.js";

// The parser reads token categories off the objects produced by the lexer.
// The category field on a lexer token is named `kind` (see lexer.js), but the
// parser's peekKind() reads `.type`, which is always undefined — so every parse
// throws. The fix is only correct once you read lexer.js to learn the real
// field name.

describe("tinycalc parser", () => {
  test("single number", () => {
    expect(parse("42")).toBe(42);
  });

  test("addition", () => {
    expect(parse("1 + 2")).toBe(3);
  });

  test("subtraction", () => {
    expect(parse("10 - 4")).toBe(6);
  });

  test("multiplication binds tighter than addition", () => {
    expect(parse("2 + 3 * 4")).toBe(14);
  });

  test("division", () => {
    expect(parse("20 / 5")).toBe(4);
  });

  test("parentheses override precedence", () => {
    expect(parse("(2 + 3) * 4")).toBe(20);
  });

  test("left-associative subtraction chain", () => {
    expect(parse("10 - 3 - 2")).toBe(5);
  });

  test("nested parentheses", () => {
    expect(parse("((1 + 2) * (3 + 4))")).toBe(21);
  });

  test("whitespace is ignored", () => {
    expect(parse("  7\t*\n6 ")).toBe(42);
  });
});
