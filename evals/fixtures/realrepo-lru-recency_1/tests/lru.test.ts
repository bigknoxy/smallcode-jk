import { test, expect, describe } from "bun:test";
import createLRU from "../src/index.js";

describe("createLRU", () => {
  test("basic set/get works", () => {
    const lru = createLRU(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBe(2);
  });

  test("eviction without any get evicts the first-inserted key", () => {
    const lru = createLRU(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
  });

  test("a get() refreshes recency so the key survives the next eviction", () => {
    const lru = createLRU(2);
    lru.set("a", 1);
    lru.set("b", 2);
    // Reading 'a' should mark it as most-recently-used.
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    // 'b' is now the true least-recently-used key and should be evicted,
    // NOT 'a' (which was just read).
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe(1);
    expect(lru.get("c")).toBe(3);
  });

  test("keys() order reflects recency after a get()", () => {
    const lru = createLRU(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    lru.get("a");
    expect(lru.keys()).toEqual(["b", "c", "a"]);
  });

  test("repeated get() on the same key keeps it alive across multiple evictions", () => {
    const lru = createLRU(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);
    lru.get("a");
    lru.set("d", 4);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("d")).toBe(4);
    expect(lru.get("c")).toBeUndefined();
  });
});
