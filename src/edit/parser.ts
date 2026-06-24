import type { EditBlock, ParseError, ParseResult } from "./types.ts";
import { parsePatchBlocks, patchBlockToEditBlock } from "./patch-function.ts";

// ---------------------------------------------------------------------------
// Search/replace format
// ---------------------------------------------------------------------------

// Regex pieces (all case-insensitive where noted).
// Accept 3+ angle brackets, optionally followed by a `<` or `>` HTML-tag wrapper.
// VibeThinker-3B emits: canonical (7), 6-9+ bare brackets, or `<<< <search>` HTML-style.
const SEARCH_RE = /^<{3,}\s*<?SEARCH>?\s*$/i;
const SEP_RE = /^={3,}\s*$/;
const REPLACE_RE = /^>{3,}\s*<?REPLACE>?\s*$/i;

function normalizePath(raw: string): string {
  // Strip leading "./" and normalize backslashes to forward slashes
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function parseSearchReplace(raw: string): { blocks: EditBlock[]; errors: ParseError[] } {
  const blocks: EditBlock[] = [];
  const errors: ParseError[] = [];

  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Look for a SEARCH marker
    if (!SEARCH_RE.test(line.trimEnd())) {
      i++;
      continue;
    }

    const searchMarkerLine = i;

    // File path is the non-empty, non-marker line immediately before the SEARCH marker
    // Walk backwards skipping blank lines
    let pathLineIdx = i - 1;
    while (pathLineIdx >= 0 && (lines[pathLineIdx] ?? "").trim() === "") {
      pathLineIdx--;
    }

    const pathCandidate = pathLineIdx >= 0 ? (lines[pathLineIdx] ?? "").trimEnd() : "";

    if (
      !pathCandidate ||
      SEARCH_RE.test(pathCandidate) ||
      SEP_RE.test(pathCandidate) ||
      REPLACE_RE.test(pathCandidate) ||
      /<<{5,}/.test(pathCandidate) ||
      />>{5,}/.test(pathCandidate)
    ) {
      errors.push({
        message: "SEARCH marker found but no valid file path on preceding line",
        line: searchMarkerLine + 1,
        raw: line,
      });
      i++;
      continue;
    }

    // Collect SEARCH content (lines after <<<<<<< SEARCH until =======)
    i++;
    const searchLines: string[] = [];
    let foundSep = false;
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (SEP_RE.test(l.trimEnd())) {
        foundSep = true;
        i++;
        break;
      }
      searchLines.push(l);
      i++;
    }

    if (!foundSep) {
      errors.push({
        message: "Missing ======= separator after SEARCH block",
        line: searchMarkerLine + 1,
        raw: pathCandidate,
      });
      continue;
    }

    // Collect REPLACE content (lines after ======= until >>>>>>> REPLACE)
    const replaceLines: string[] = [];
    let foundEnd = false;
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (REPLACE_RE.test(l.trimEnd())) {
        foundEnd = true;
        i++;
        break;
      }
      replaceLines.push(l);
      i++;
    }

    if (!foundEnd) {
      errors.push({
        message: "Missing >>>>>>> REPLACE marker after REPLACE block",
        line: searchMarkerLine + 1,
        raw: pathCandidate,
      });
      continue;
    }

    const filePath = normalizePath(pathCandidate);
    const search = searchLines.join("\n");
    const replace = replaceLines.join("\n");

    blocks.push({ filePath, search, replace, format: "search-replace" });
  }

  return { blocks, errors };
}

// ---------------------------------------------------------------------------
// Full-file format
// ---------------------------------------------------------------------------
//
// Small models botch SEARCH/REPLACE anchors (exact-match whitespace, marker
// chars, the ======= separator). The whole-file format removes all of that: the
// model names a file and emits its complete corrected contents in a fenced block.
//
//   FILE: src/math.ts
//   ```ts
//   export function add(a: number, b: number): number {
//     return a + b;
//   }
//   ```
//
// search="" tells the applier to overwrite the whole file (see applyBlock).
const FILE_RE = /^\s*FILE:\s*(.+?)\s*$/i;
const FENCE_RE = /^\s*```/;

function parseFullFile(raw: string): { blocks: EditBlock[]; errors: ParseError[] } {
  const blocks: EditBlock[] = [];
  const errors: ParseError[] = [];
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const m = (lines[i] ?? "").match(FILE_RE);
    if (!m) {
      i++;
      continue;
    }
    const pathCandidate = m[1] ?? "";
    const fileMarkerLine = i;
    i++;

    // Skip blank lines, then require an opening fence.
    while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
    if (i >= lines.length || !FENCE_RE.test(lines[i] ?? "")) {
      errors.push({
        message: "FILE: marker found but no opening ``` code fence followed",
        line: fileMarkerLine + 1,
        raw: lines[fileMarkerLine] ?? "",
      });
      continue;
    }
    i++; // consume opening fence

    // Collect until closing fence.
    const contentLines: string[] = [];
    let closed = false;
    while (i < lines.length) {
      if (FENCE_RE.test(lines[i] ?? "")) {
        closed = true;
        i++;
        break;
      }
      contentLines.push(lines[i] ?? "");
      i++;
    }
    if (!closed) {
      errors.push({
        message: "FILE: block missing closing ``` fence",
        line: fileMarkerLine + 1,
        raw: pathCandidate,
      });
      continue;
    }

    const filePath = normalizePath(pathCandidate);
    // Preserve a trailing newline (most source files end with one).
    const replace = `${contentLines.join("\n")}\n`;
    blocks.push({ filePath, search: "", replace, format: "full-file" });
  }

  return { blocks, errors };
}

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

interface RawEditObject {
  type: string;
  file?: unknown;
  search?: unknown;
  replace?: unknown;
}

function looksLikeEditObject(obj: unknown): obj is RawEditObject {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    (obj as Record<string, unknown>)["type"] === "edit"
  );
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];

  // Extract from markdown fences: ```json ... ``` or ``` ... ```
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g;
  for (const m of raw.matchAll(fenceRe)) {
    candidates.push(m[1] ?? "");
  }

  // Also try bare JSON objects/arrays (greedy scan for { or [)
  // Simple approach: find all top-level { ... } and [ ... ] spans
  for (let start = 0; start < raw.length; start++) {
    const ch = raw[start];
    if (ch !== "{" && ch !== "[") continue;
    const closing = ch === "{" ? "}" : "]";
    let depth = 0;
    let end = start;
    for (let j = start; j < raw.length; j++) {
      if (raw[j] === ch) depth++;
      else if (raw[j] === closing) {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end > start) {
      candidates.push(raw.slice(start, end + 1));
      start = end; // skip past this span
    }
  }

  return candidates;
}

function parseJson(raw: string): { blocks: EditBlock[]; errors: ParseError[] } {
  const blocks: EditBlock[] = [];
  const errors: ParseError[] = [];

  // Quick bail: must contain "type":"edit" or "type": "edit"
  if (!/"type"\s*:\s*"edit"/.test(raw)) {
    return { blocks, errors };
  }

  const candidates = extractJsonCandidates(raw);
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Only report error if this candidate looked like it had edit objects
      if (/"type"\s*:\s*"edit"/.test(trimmed)) {
        errors.push({ message: "Malformed JSON edit block", raw: trimmed.slice(0, 120) });
      }
      continue;
    }

    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!looksLikeEditObject(item)) continue;
      const filePath = typeof item.file === "string" ? normalizePath(item.file) : "";
      const search = typeof item.search === "string" ? item.search : "";
      const replace = typeof item.replace === "string" ? item.replace : "";
      blocks.push({ filePath, search, replace, format: "json" });
    }
  }

  return { blocks, errors };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateBlocks(blocks: EditBlock[], errors: ParseError[]): EditBlock[] {
  const valid: EditBlock[] = [];

  for (const block of blocks) {
    if (!block.filePath) {
      errors.push({ message: "Edit block has empty file path", raw: block.search.slice(0, 60) });
      continue;
    }
    if (block.filePath.startsWith("/")) {
      errors.push({
        message: `Absolute path rejected: ${block.filePath}`,
        raw: block.filePath,
      });
      continue;
    }
    if (block.filePath.split("/").some((seg) => seg === "..")) {
      errors.push({
        message: `Path traversal rejected: ${block.filePath}`,
        raw: block.filePath,
      });
      continue;
    }
    valid.push(block);
  }

  return valid;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parse(raw: string): ParseResult {
  const errors: ParseError[] = [];

  // PATCH format — check first; `PATCH:` prefix is unambiguous and distinct from FILE:/SEARCH.
  const patchResult = parsePatchBlocks(raw);
  errors.push(...(patchResult.errors as ParseError[]));
  if (patchResult.blocks.length > 0) {
    const editBlocks = patchResult.blocks.map(patchBlockToEditBlock);
    const validBlocks = validateBlocks(editBlocks, errors);
    if (validBlocks.length > 0) return { blocks: validBlocks, errors, raw };
  }

  // Full-file format first — it is the primary format for small models and the
  // most reliable. An explicit `FILE:` marker makes it unambiguous vs S/R.
  const ffResult = parseFullFile(raw);
  if (ffResult.blocks.length > 0) {
    const validBlocks = validateBlocks(ffResult.blocks, errors);
    if (validBlocks.length > 0) return { blocks: validBlocks, errors, raw };
  }

  // Then search/replace
  const srResult = parseSearchReplace(raw);
  errors.push(...srResult.errors);

  if (srResult.blocks.length > 0) {
    const validBlocks = validateBlocks(srResult.blocks, errors);
    return { blocks: validBlocks, errors, raw };
  }

  // Fall back to JSON
  const jsonResult = parseJson(raw);
  errors.push(...jsonResult.errors);

  const validBlocks = validateBlocks(jsonResult.blocks, errors);
  return { blocks: validBlocks, errors, raw };
}
