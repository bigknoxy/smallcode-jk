export interface ParsedResponse {
  reasoning: string | null;
  answer: string;
}

export function parseReasoning(raw: string): ParsedResponse {
  const match = raw.match(/<think>([\s\S]*?)<\/think>/);
  const reasoning = match ? (match[1] ?? null) : null;
  const answer = match ? raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim() : raw;
  return { reasoning, answer };
}
