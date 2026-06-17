import { test, expect } from "bun:test";
import { isPalindrome } from "../src/palindrome";

test("simple palindrome", () => {
  expect(isPalindrome("racecar")).toBe(true);
});

test("not a palindrome", () => {
  expect(isPalindrome("hello")).toBe(false);
});

test("case insensitive", () => {
  expect(isPalindrome("RaceCar")).toBe(true);
});

test("ignores spaces and punctuation", () => {
  expect(isPalindrome("A man, a plan, a canal: Panama")).toBe(true);
});

test("empty string is palindrome", () => {
  expect(isPalindrome("")).toBe(true);
});

test("single char is palindrome", () => {
  expect(isPalindrome("a")).toBe(true);
});
