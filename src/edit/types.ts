export type EditFormat = "search-replace" | "json" | "full-file" | "patch-function";

export interface EditBlock {
  filePath: string; // relative to repo root
  search: string; // exact text to find (empty string = full file replace / new file)
  replace: string; // replacement text
  format: EditFormat;
}

export interface ParseResult {
  blocks: EditBlock[];
  errors: ParseError[];
  raw: string;
}

export interface ParseError {
  message: string;
  line?: number;
  raw?: string;
}

export type ApplyStatus = "applied" | "not_found" | "ambiguous" | "error";

export interface ApplyResult {
  filePath: string;
  status: ApplyStatus;
  diff?: string; // unified diff string, populated on success
  error?: string;
  originalContent?: string;
  newContent?: string;
  /**
   * Set when a search/replace block only matched after fuzzy repair (the model's
   * search text drifted from the source — whitespace/indent/near-miss). Records
   * which repair strategy salvaged it and the confidence, for telemetry.
   */
  repair?: { strategy: RepairResult["strategy"]; confidence: number };
}

export interface ApplyBatchResult {
  results: ApplyResult[];
  allApplied: boolean;
}

export interface RepairResult {
  repairedBlock: EditBlock | null;
  strategy: "exact" | "fuzzy" | "whitespace" | "failed";
  confidence: number; // 0–1
}
