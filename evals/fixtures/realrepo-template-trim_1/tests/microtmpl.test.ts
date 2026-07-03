import { test, expect, describe } from "bun:test";
import render from "../src/index.js";

describe("render", () => {
  test("interpolates a single spaced variable", () => {
    expect(render("Hi {{ name }}!", { name: "Al" })).toBe("Hi Al!");
  });

  test("interpolates mixed spacing across multiple variables", () => {
    expect(render("{{a}}-{{ b }}", { a: "1", b: "2" })).toBe("1-2");
  });

  test("passes text through unchanged when there are no variables", () => {
    expect(render("just plain text", {})).toBe("just plain text");
  });

  test("renders empty string for a missing key", () => {
    expect(render("Hi {{ name }}!", {})).toBe("Hi !");
  });

  test("interpolates a variable with extra surrounding whitespace", () => {
    expect(render("{{   title   }}", { title: "Report" })).toBe("Report");
  });
});
