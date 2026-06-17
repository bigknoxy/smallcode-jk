export interface ParsedResponse {
  reasoning: string | null;
  answer: string;
  hasReasoning: boolean;
}

export interface ReasoningLogEntry {
  timestamp: number;
  modelId: string;
  reasoning: string;
  answerLength: number;
}
