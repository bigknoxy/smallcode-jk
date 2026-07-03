import { test, expect, describe } from "bun:test";
import parse from "../src/index.js";

describe("parse", () => {
  test("repeated bracket keys collect into an array", () => {
    expect(parse("a[]=1&a[]=2")).toEqual({ a: ["1", "2"] });
  });

  test("plain keys stay scalar", () => {
    expect(parse("x=1&y=2")).toEqual({ x: "1", y: "2" });
  });

  test("single bracket key still yields an array", () => {
    expect(parse("a[]=1")).toEqual({ a: ["1"] });
  });

  test("mixed bracket and plain keys", () => {
    expect(parse("a[]=1&b=2&a[]=3")).toEqual({ a: ["1", "3"], b: "2" });
  });

  test("empty string yields empty object", () => {
    expect(parse("")).toEqual({});
  });

  test("three repeated bracket keys collect in order", () => {
    expect(parse("tags[]=x&tags[]=y&tags[]=z")).toEqual({ tags: ["x", "y", "z"] });
  });
});
