export interface ParsedResponse {
  reasoning: string | null;
  answer: string;
}

export function parseReasoning(raw: string): ParsedResponse {
  const thinkPattern = /<think>([\s\S]*?)<\/think>/g;
  const reasoningParts: string[] = [];
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = thinkPattern.exec(raw)) !== null) {
    reasoningParts.push(match[1] ?? "");
    lastEnd = match.index + match[0].length;
  }
  const reasoning = reasoningParts.length > 0 ? reasoningParts.join("\n") : null;
  // Answer is everything after the last </think> tag
  const answer = reasoningParts.length > 0 ? raw.slice(lastEnd).trim() : raw;
  return { reasoning, answer };
}
