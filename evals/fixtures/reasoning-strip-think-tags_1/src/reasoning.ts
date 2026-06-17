export interface ParsedResponse {
  reasoning: string | null;
  answer: string;
}

export function parseReasoning(raw: string): ParsedResponse {
  const match = raw.match(/<think>([\s\S]*?)<\/think>/);
  if (!match) return { reasoning: null, answer: raw };
  const reasoning = match[1] ?? null;
  const answer = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return { reasoning, answer };
}
