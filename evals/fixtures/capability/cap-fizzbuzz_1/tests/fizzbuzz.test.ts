import { test, expect } from "bun:test";
import { fizzbuzz } from "../src/fizzbuzz";

test("returns correct length", () => {
  expect(fizzbuzz(15).length).toBe(15);
});

test("multiples of 3 are Fizz", () => {
  const result = fizzbuzz(15);
  expect(result[2]).toBe("Fizz");
  expect(result[5]).toBe("Fizz");
  expect(result[8]).toBe("Fizz");
});

test("multiples of 5 are Buzz", () => {
  const result = fizzbuzz(15);
  expect(result[4]).toBe("Buzz");
  expect(result[9]).toBe("Buzz");
});

test("multiples of 15 are FizzBuzz", () => {
  const result = fizzbuzz(15);
  expect(result[14]).toBe("FizzBuzz");
});

test("other numbers are strings of the number", () => {
  const result = fizzbuzz(5);
  expect(result[0]).toBe("1");
  expect(result[1]).toBe("2");
  expect(result[3]).toBe("4");
});
