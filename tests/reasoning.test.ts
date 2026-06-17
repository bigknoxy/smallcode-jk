import { beforeEach, describe, expect, it } from "bun:test";
import { ReasoningHandler } from "@/reasoning/handler";
import { ReasoningLogger } from "@/reasoning/logger";
import type { ReasoningLogEntry } from "@/reasoning/types";

const defaultTags = { open: "<think>", close: "</think>" };

describe("ReasoningHandler", () => {
  let handler: ReasoningHandler;

  beforeEach(() => {
    handler = new ReasoningHandler(defaultTags);
  });

  // 1. No tags → answer = raw, reasoning = null
  it("returns raw as answer when no tags present", () => {
    const result = handler.parse("just a plain answer");
    expect(result.reasoning).toBeNull();
    expect(result.answer).toBe("just a plain answer");
    expect(result.hasReasoning).toBe(false);
  });

  it("trims whitespace from plain answer with no tags", () => {
    const result = handler.parse("  spaced answer  ");
    expect(result.answer).toBe("spaced answer");
    expect(result.reasoning).toBeNull();
  });

  // 2. Normal <think>content</think>answer → correct split
  it("splits reasoning and answer correctly", () => {
    const result = handler.parse("<think>step 1\nstep 2</think>final answer");
    expect(result.reasoning).toBe("step 1\nstep 2");
    expect(result.answer).toBe("final answer");
    expect(result.hasReasoning).toBe(true);
  });

  // 3. Multiple blocks → all reasoning concatenated, answer is remainder
  it("concatenates multiple reasoning blocks and collects answer parts", () => {
    const raw = "<think>block one</think>between<think>block two</think>end";
    const result = handler.parse(raw);
    expect(result.reasoning).toBe("block one\nblock two");
    expect(result.answer).toBe("betweenend");
    expect(result.hasReasoning).toBe(true);
  });

  it("handles content before the first open tag", () => {
    const raw = "prefix<think>reasoning</think>suffix";
    const result = handler.parse(raw);
    expect(result.reasoning).toBe("reasoning");
    expect(result.answer).toBe("prefixsuffix");
  });

  // 4. Only open tag, no close → reasoning = text after open, answer = ""
  it("handles truncated output with only open tag", () => {
    const raw = "<think>partial reasoning without end";
    const result = handler.parse(raw);
    expect(result.reasoning).toBe("partial reasoning without end");
    expect(result.answer).toBe("");
    expect(result.hasReasoning).toBe(true);
  });

  // 5. Empty reasoning block <think></think>answer
  it("handles empty reasoning block", () => {
    const raw = "<think></think>answer text";
    const result = handler.parse(raw);
    expect(result.reasoning).toBe("");
    expect(result.answer).toBe("answer text");
    expect(result.hasReasoning).toBe(true);
  });

  // 6. Whitespace trimming on both parts
  it("trims whitespace from answer", () => {
    const raw = "<think>  reasoning  </think>  answer with spaces  ";
    const result = handler.parse(raw);
    expect(result.answer).toBe("answer with spaces");
    // reasoning is not trimmed — raw content preserved
    expect(result.reasoning).toBe("  reasoning  ");
  });

  it("trims when multiple blocks produce whitespace-only answer", () => {
    const raw = "<think>r1</think>   <think>r2</think>   ";
    const result = handler.parse(raw);
    // answer parts are "   " + "   " = "      " which trims to ""
    expect(result.answer).toBe("");
    expect(result.reasoning).toBe("r1\nr2");
  });

  // 7. strip() removes all reasoning blocks, returns clean answer
  it("strip removes reasoning blocks", () => {
    const raw = "<think>chain of thought</think>clean answer";
    expect(handler.strip(raw)).toBe("clean answer");
  });

  it("strip returns plain string unchanged (trimmed)", () => {
    expect(handler.strip("  plain  ")).toBe("plain");
  });

  it("strip handles multiple blocks", () => {
    const raw = "<think>r1</think>part1<think>r2</think>part2";
    expect(handler.strip(raw)).toBe("part1part2");
  });

  // 8. hasReasoning() returns correct boolean
  it("hasReasoning returns true when open tag present", () => {
    expect(handler.hasReasoning("<think>some thought</think>")).toBe(true);
  });

  it("hasReasoning returns false when no open tag", () => {
    expect(handler.hasReasoning("no tags here")).toBe(false);
  });

  it("hasReasoning returns true even for truncated output", () => {
    expect(handler.hasReasoning("<think>no close tag")).toBe(true);
  });

  // 9. parseStreaming returns null when incomplete (no close tag, not done)
  it("parseStreaming returns null when stream not done and no close tag", () => {
    const result = handler.parseStreaming("<think>partial", false);
    expect(result).toBeNull();
  });

  it("parseStreaming returns null for empty accumulated when not done", () => {
    const result = handler.parseStreaming("", false);
    expect(result).toBeNull();
  });

  // 10. parseStreaming returns result when streamDone=true
  it("parseStreaming returns parse result when streamDone=true", () => {
    const result = handler.parseStreaming("<think>reasoning</think>answer", true);
    expect(result).not.toBeNull();
    expect(result?.reasoning).toBe("reasoning");
    expect(result?.answer).toBe("answer");
  });

  it("parseStreaming returns result even for truncated stream when done", () => {
    const result = handler.parseStreaming("<think>no close", true);
    expect(result).not.toBeNull();
    expect(result?.reasoning).toBe("no close");
    expect(result?.answer).toBe("");
  });

  it("parseStreaming returns result when close tag is present even if not done", () => {
    const result = handler.parseStreaming("<think>r</think>ans", false);
    expect(result).not.toBeNull();
    expect(result?.answer).toBe("ans");
  });

  it("parseStreaming returns null when no tags and stream not done", () => {
    const result = handler.parseStreaming("building answer...", false);
    // No open tag and no close tag — still null (incomplete)
    expect(result).toBeNull();
  });

  // 11. Different tag pairs (configurable open/close)
  it("works with custom tag pairs", () => {
    const customHandler = new ReasoningHandler({ open: "[THINK]", close: "[/THINK]" });
    const raw = "[THINK]chain[/THINK]result";
    const result = customHandler.parse(raw);
    expect(result.reasoning).toBe("chain");
    expect(result.answer).toBe("result");
    expect(result.hasReasoning).toBe(true);
  });

  it("custom tags: hasReasoning uses correct open tag", () => {
    const customHandler = new ReasoningHandler({ open: "<<think>>", close: "<</think>>" });
    expect(customHandler.hasReasoning("<<think>>something")).toBe(true);
    expect(customHandler.hasReasoning("<think>something</think>")).toBe(false);
  });
});

describe("ReasoningLogger", () => {
  const makeEntry = (reasoning: string, modelId = "model-a"): ReasoningLogEntry => ({
    timestamp: Date.now(),
    modelId,
    reasoning,
    answerLength: 42,
  });

  // 12. Circular buffer respects maxEntries
  it("stores entries and retrieves them", () => {
    const logger = new ReasoningLogger(10);
    logger.log(makeEntry("thought 1"));
    logger.log(makeEntry("thought 2"));
    const entries = logger.getRecent();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.reasoning).toBe("thought 1");
    expect(entries[1]?.reasoning).toBe("thought 2");
  });

  it("circular buffer evicts oldest entry when full", () => {
    const logger = new ReasoningLogger(3);
    logger.log(makeEntry("first"));
    logger.log(makeEntry("second"));
    logger.log(makeEntry("third"));
    logger.log(makeEntry("fourth")); // should evict "first"
    const entries = logger.getRecent();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.reasoning).toBe("second");
    expect(entries[2]?.reasoning).toBe("fourth");
  });

  it("getRecent(n) returns last n entries", () => {
    const logger = new ReasoningLogger(10);
    for (let i = 0; i < 5; i++) {
      logger.log(makeEntry(`thought ${i}`));
    }
    const recent = logger.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.reasoning).toBe("thought 3");
    expect(recent[1]?.reasoning).toBe("thought 4");
  });

  it("getRecent() with no arg returns all entries", () => {
    const logger = new ReasoningLogger(10);
    logger.log(makeEntry("a"));
    logger.log(makeEntry("b"));
    expect(logger.getRecent()).toHaveLength(2);
  });

  it("clear empties the buffer", () => {
    const logger = new ReasoningLogger(10);
    logger.log(makeEntry("a"));
    logger.log(makeEntry("b"));
    logger.clear();
    expect(logger.getRecent()).toHaveLength(0);
  });

  it("uses default maxEntries of 100", () => {
    const logger = new ReasoningLogger();
    for (let i = 0; i < 105; i++) {
      logger.log(makeEntry(`entry ${i}`));
    }
    const entries = logger.getRecent();
    expect(entries).toHaveLength(100);
    expect(entries[0]?.reasoning).toBe("entry 5");
  });

  it("getRecent returns a copy, not the internal buffer", () => {
    const logger = new ReasoningLogger(10);
    logger.log(makeEntry("original"));
    const copy = logger.getRecent();
    copy.push(makeEntry("injected"));
    expect(logger.getRecent()).toHaveLength(1);
  });
});
