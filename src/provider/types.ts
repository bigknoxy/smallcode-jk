export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  stream?: boolean;
  responseFormat?: { type: "json_schema"; schema: Record<string, unknown> } | { type: "text" };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionResponse {
  rawContent: string;
  usage?: TokenUsage;
  model: string;
  finishReason?: string;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
}

export interface Provider {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  stream(req: CompletionRequest): AsyncIterableIterator<StreamChunk>;
}

export class ProviderError extends Error {
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { statusCode?: number; retryable: boolean }) {
    super(message);
    this.name = "ProviderError";
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
  }
}
