export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "const"
  | "variable"
  | "export";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  line: number; // 1-based
  endLine: number; // 1-based, inclusive
  signature?: string; // compact one-line representation
}

export interface FileMap {
  path: string; // relative to repo root, forward slashes
  language: string; // "typescript" | "javascript" | "python" | "go" | "rust" | "unknown"
  symbols: CodeSymbol[];
  lineCount: number;
  sizeBytes: number;
}

export interface RepoMap {
  root: string; // absolute path
  files: FileMap[];
  totalSymbols: number;
  builtAt: number; // Date.now() equivalent — caller passes this in
}

export interface ContextChunk {
  filePath: string; // relative to repo root
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  content: string;
  estimatedTokens: number;
}

export interface ContextBundle {
  chunks: ContextChunk[];
  totalTokens: number;
  tokenBudget: number;
  truncated: boolean;
  query: string;
}
