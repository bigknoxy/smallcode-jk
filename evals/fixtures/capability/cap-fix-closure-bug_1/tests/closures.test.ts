import { test, expect } from "bun:test";
import { makeCounters } from "../src/closures";

test("each counter returns its own index", () => {
  const counters = makeCounters(3);
  expect(counters[0]()).toBe(0);
  expect(counters[1]()).toBe(1);
  expect(counters[2]()).toBe(2);
});

test("single counter", () => {
  const counters = makeCounters(1);
  expect(counters[0]()).toBe(0);
});

test("five counters", () => {
  const counters = makeCounters(5);
  for (let j = 0; j < 5; j++) {
    expect(counters[j]()).toBe(j);
  }
});
