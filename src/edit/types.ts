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
  /**
   * The file's content BEFORE this batch FIRST modified it. For a single block
   * this is the on-disk content prior to the edit; for multiple blocks targeting
   * the same file it is the content before the FIRST edit to that file (NOT the
   * intermediate in-memory state), so reverting it fully undoes the whole batch.
   * Undefined for a brand-new file (no prior content) — revert skips those.
   */
  originalContent?: string;
  newContent?: string;
  /**
   * The path actually written, AFTER any path-typo rescue (dots→slashes). May
   * differ from `filePath` when the model flattened the separators. Revert must
   * restore `originalContent` to THIS path, not the emitted (typo) path.
   */
  effectivePath?: string;
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
