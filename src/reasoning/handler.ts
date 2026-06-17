import type { ReasoningTags } from "@/models/types";
import type { ParsedResponse } from "./types";

export class ReasoningHandler {
  private readonly open: string;
  private readonly close: string;

  constructor(tags: ReasoningTags) {
    this.open = tags.open;
    this.close = tags.close;
  }

  parse(raw: string): ParsedResponse {
    const openTag = this.open;
    const closeTag = this.close;

    // Quick check — no open tag at all
    if (!raw.includes(openTag)) {
      return { reasoning: null, answer: raw.trim(), hasReasoning: false };
    }

    const reasoningParts: string[] = [];
    const answerParts: string[] = [];
    let cursor = 0;

    while (cursor < raw.length) {
      const openIdx = raw.indexOf(openTag, cursor);

      if (openIdx === -1) {
        // No more open tags — rest is answer content
        answerParts.push(raw.slice(cursor));
        break;
      }

      // Content before this open tag goes to answer
      if (openIdx > cursor) {
        answerParts.push(raw.slice(cursor, openIdx));
      }

      const contentStart = openIdx + openTag.length;
      const closeIdx = raw.indexOf(closeTag, contentStart);

      if (closeIdx === -1) {
        // Truncated — no close tag found; everything after open tag is reasoning
        reasoningParts.push(raw.slice(contentStart));
        // answer receives nothing more
        cursor = raw.length;
        break;
      }

      // Normal block
      reasoningParts.push(raw.slice(contentStart, closeIdx));
      cursor = closeIdx + closeTag.length;
    }

    const reasoning = reasoningParts.join("\n");
    const answer = answerParts.join("").trim();

    return {
      reasoning,
      answer,
      hasReasoning: true,
    };
  }

  strip(raw: string): string {
    return this.parse(raw).answer;
  }

  hasReasoning(raw: string): boolean {
    return raw.includes(this.open);
  }

  parseStreaming(accumulated: string, streamDone: boolean): ParsedResponse | null {
    // If not done and no close tag present, the stream is still mid-reasoning
    if (!streamDone && !accumulated.includes(this.close)) {
      return null;
    }
    return this.parse(accumulated);
  }
}
