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
  /**
   * The target file the model is being asked to edit. Pinned chunks are NEVER
   * windowed (always the whole file) and NEVER shed by fitTurnPromptToWindow —
   * the model cannot reproduce a file it cannot see in full. At most one chunk
   * per bundle is pinned (the target source file).
   */
  pinned?: boolean;
}

/**
 * The file the agent is expected to edit this turn, plus the deterministic edit
 * format the harness has chosen for it based on size. Lets the prompt issue an
 * explicit FILE:/PATCH: directive instead of leaving a small model to guess
 * whether a file is "large", and lets the executor verify the model edited the
 * file it was pointed at.
 */
export interface TargetFile {
  path: string; // relative to repo root
  lineCount: number;
  /** "full" ⇒ emit whole file (FILE:); "patch" ⇒ edit one function (PATCH:). */
  format: "full" | "patch";
  /** Best-scoring matched symbol — the function to PATCH when format==="patch". */
  functionName?: string;
  /** Line span of the target function (endLine − line + 1), when known. Drives the
   * size-gated minimal-diff format: a minimal SEARCH/REPLACE pays off on LARGE
   * functions (where whole-function re-emission over-edits) but hurts small ones
   * (where whole-function PATCH already works and exact-match S/R adds fragility). */
  functionLineCount?: number;
}

export interface ContextBundle {
  chunks: ContextChunk[];
  totalTokens: number;
  tokenBudget: number;
  truncated: boolean;
  query: string;
  /** Set when a confident edit target was identified (score-ranked source file). */
  targetFile?: TargetFile;
}
