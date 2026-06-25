import { test, expect } from "bun:test";
import { toCamel, toKebab, toSnake } from "../src/casing.ts";

test("toCamel from space-separated", () => {
  expect(toCamel("hello world")).toBe("helloWorld");
  expect(toCamel("the quick brown fox")).toBe("theQuickBrownFox");
});

test("toCamel from mixed separators and camel boundaries", () => {
  expect(toCamel("foo_bar-baz")).toBe("fooBarBaz");
  expect(toCamel("alreadyCamelCase")).toBe("alreadyCamelCase");
  expect(toCamel("HTTPServer error")).toBe("httpserverError");
});

test("toKebab basic", () => {
  expect(toKebab("hello world")).toBe("hello-world");
  expect(toKebab("fooBar")).toBe("foo-bar");
  expect(toKebab("foo_bar baz")).toBe("foo-bar-baz");
});

test("toKebab collapses repeated separators", () => {
  expect(toKebab("a__b--c  d")).toBe("a-b-c-d");
});

test("toSnake basic", () => {
  expect(toSnake("hello world")).toBe("hello_world");
  expect(toSnake("fooBar")).toBe("foo_bar");
  expect(toSnake("foo-bar baz")).toBe("foo_bar_baz");
});

test("empty input yields empty string", () => {
  expect(toCamel("")).toBe("");
  expect(toKebab("   ")).toBe("");
  expect(toSnake("")).toBe("");
});

test("number boundaries split", () => {
  expect(toKebab("version2Point0")).toBe("version2-point0");
  expect(toSnake("item1Name")).toBe("item1_name");
});
