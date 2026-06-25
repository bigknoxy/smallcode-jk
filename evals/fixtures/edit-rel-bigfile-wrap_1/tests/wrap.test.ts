import { test, expect } from "bun:test";
import { wrapText, splitWords, breakLongWord, padRight } from "../src/wrap.ts";

test("splitWords collapses whitespace", () => {
  expect(splitWords("  a  b\tc\nd ")).toEqual(["a", "b", "c", "d"]);
  expect(splitWords("")).toEqual([]);
  expect(splitWords("single")).toEqual(["single"]);
});

test("greedy wrap packs words up to width", () => {
  // width 11: "the quick" = 9, +" brown" = 15 > 11 -> new line
  expect(wrapText("the quick brown fox", 11)).toEqual(["the quick", "brown fox"]);
});

test("wrap fits exact-width line without overflow", () => {
  // "aaa bbb" is exactly 7 chars and must stay on one line at width 7.
  expect(wrapText("aaa bbb", 7)).toEqual(["aaa bbb"]);
  // At width 6 it must break.
  expect(wrapText("aaa bbb", 6)).toEqual(["aaa", "bbb"]);
});

test("never splits a word that fits", () => {
  expect(wrapText("hello world", 5)).toEqual(["hello", "world"]);
});

test("hard-splits a single over-long word", () => {
  expect(breakLongWord("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  expect(wrapText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
});

test("over-long word interleaves with normal words", () => {
  // "supercali" (9) at width 4 -> "supe","rcal","i"; then "ok" joins last? no:
  // last fragment "i" then "ok" -> "i ok" = 4 fits.
  expect(wrapText("supercali ok", 4)).toEqual(["supe", "rcal", "i ok"]);
});

test("breakLongWord leaves short words intact", () => {
  expect(breakLongWord("hi", 5)).toEqual(["hi"]);
  expect(breakLongWord("exact", 5)).toEqual(["exact"]);
});

test("padRight pads to width and leaves long strings", () => {
  expect(padRight("ab", 5)).toBe("ab   ");
  expect(padRight("abcde", 5)).toBe("abcde");
  expect(padRight("abcdef", 5)).toBe("abcdef");
});

test("empty text yields a single empty line", () => {
  expect(wrapText("", 10)).toEqual([""]);
  expect(wrapText("   ", 10)).toEqual([""]);
});
