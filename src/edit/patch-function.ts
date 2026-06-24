/**
 * PATCH block format — function/region replacement for large files.
 *
 * Syntax:
 *   PATCH: src/foo.ts
 *   FUNCTION: functionName
 *   ```
 *   <complete replacement of just that function>
 *   ```
 *
 * The anchor is the function signature line (first line of the replacement block)
 * matched as a stable prefix in the file. The applier locates the function by
 * scanning for a line whose trimmed content equals the trimmed first line of the
 * replacement, then replaces the entire function body (up to the next top-level
 * closing brace).
 *
 * FAIL SAFE: ambiguous or not-found anchor → ApplyResult with status !== "applied",
 * NO write performed. The loop surfaces this and the model falls back to full-file.
 */

import type { ApplyResult, EditBlock } from "./types.ts";
import { generateDiff } from "./applier.ts";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Lines threshold above which PATCH format is recommended. */
export const PATCH_LINE_THRESHOLD = 300;

/** Byte threshold above which PATCH format is recommended. */
export const PATCH_BYTE_THRESHOLD = 8192;

// ---------------------------------------------------------------------------
// chooseEditFormat
// ---------------------------------------------------------------------------

/**
 * Advisory helper: returns "patch" if the file metric exceeds the threshold,
 * "full" otherwise. Drives what format the prompt RECOMMENDS; the model still
 * chooses.
 *
 * @param sizeMetric - number of lines OR number of bytes of the file
 */
export function chooseEditFormat(sizeMetric: number): "full" | "patch" {
  if (sizeMetric > PATCH_LINE_THRESHOLD || sizeMetric > PATCH_BYTE_THRESHOLD) {
    return "patch";
  }
  return "full";
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const PATCH_FILE_RE = /^\s*PATCH:\s*(.+?)\s*$/i;
const PATCH_FUNCTION_RE = /^\s*FUNCTION:\s*(.+?)\s*$/i;
const FENCE_RE = /^\s*```/;

function normalizePath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface PatchBlock {
  filePath: string;
  functionName: string;
  replacement: string; // complete replacement function text (including signature line)
  format: "patch-function";
}

export interface PatchParseError {
  message: string;
  line?: number;
  raw?: string;
}

export interface PatchParseResult {
  blocks: PatchBlock[];
  errors: PatchParseError[];
}

export function parsePatchBlocks(raw: string): PatchParseResult {
  const blocks: PatchBlock[] = [];
  const errors: PatchParseError[] = [];
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const patchMatch = (lines[i] ?? "").match(PATCH_FILE_RE);
    if (!patchMatch) {
      i++;
      continue;
    }
    const pathCandidate = patchMatch[1] ?? "";
    const patchMarkerLine = i;
    i++;

    // Skip blank lines, then require FUNCTION:
    while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
    if (i >= lines.length) {
      errors.push({
        message: "PATCH: marker found but no FUNCTION: line followed",
        line: patchMarkerLine + 1,
        raw: lines[patchMarkerLine] ?? "",
      });
      continue;
    }

    const funcMatch = (lines[i] ?? "").match(PATCH_FUNCTION_RE);
    if (!funcMatch) {
      errors.push({
        message: "PATCH: marker found but no FUNCTION: line followed",
        line: patchMarkerLine + 1,
        raw: lines[i] ?? "",
      });
      continue;
    }
    const functionName = funcMatch[1] ?? "";
    i++;

    // Skip blank lines, then require an opening fence.
    while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
    if (i >= lines.length || !FENCE_RE.test(lines[i] ?? "")) {
      errors.push({
        message: "PATCH: block missing opening ``` code fence after FUNCTION:",
        line: patchMarkerLine + 1,
        raw: lines[patchMarkerLine] ?? "",
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
        message: "PATCH: block missing closing ``` fence",
        line: patchMarkerLine + 1,
        raw: pathCandidate,
      });
      continue;
    }

    if (contentLines.length === 0) {
      errors.push({
        message: "PATCH: block has empty replacement content",
        line: patchMarkerLine + 1,
        raw: pathCandidate,
      });
      continue;
    }

    const filePath = normalizePath(pathCandidate);

    // Security: reject absolute paths and traversal
    if (filePath.startsWith("/")) {
      errors.push({
        message: `Absolute path rejected: ${filePath}`,
        raw: filePath,
      });
      continue;
    }
    if (filePath.split("/").some((seg) => seg === "..")) {
      errors.push({
        message: `Path traversal rejected: ${filePath}`,
        raw: filePath,
      });
      continue;
    }

    // Preserve trailing newline like full-file format does
    const replacement = `${contentLines.join("\n")}\n`;

    blocks.push({ filePath, functionName, replacement, format: "patch-function" });
  }

  return { blocks, errors };
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

/**
 * Locate the target function region in `content` by scanning for a line whose
 * trimmed content matches the trimmed first non-empty line of `replacement`.
 *
 * Returns the start and end indices (character positions) of the function
 * region in `content`, or null if not found / ambiguous.
 *
 * The region ends at the closing brace that brings the brace depth back to
 * the level it was BEFORE the opening line was seen (handles top-level and
 * class-method functions). For arrow functions assigned to `const` / `let`
 * / `export const` we detect the closing `};` or `}` at the correct depth.
 *
 * IMPORTANT: If the anchor line appears more than once → ambiguous → null.
 */
function locateFunctionRegion(
  content: string,
  replacement: string,
): { start: number; end: number } | { ambiguous: true } | null {
  // First non-empty line of the replacement is the anchor signature
  const replacementLines = replacement.split("\n");
  const anchorLine = replacementLines.find((l) => l.trim() !== "")?.trim();
  if (!anchorLine) return null;

  const contentLines = content.split("\n");

  // Find all lines that match the anchor (trimmed equality)
  const matchIndices: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if ((contentLines[i] ?? "").trim() === anchorLine) {
      matchIndices.push(i);
    }
  }

  if (matchIndices.length === 0) return null;
  if (matchIndices.length > 1) return { ambiguous: true };

  const startLineIdx = matchIndices[0]!;

  // Walk character positions to find the start offset
  let charPos = 0;
  for (let i = 0; i < startLineIdx; i++) {
    charPos += (contentLines[i] ?? "").length + 1; // +1 for \n
  }
  const startChar = charPos;

  // Now scan forward from the anchor line to find the end of the function.
  // We track brace depth. The region ends when depth returns to 0 (after
  // opening the first `{`).
  let depth = 0;
  let foundOpenBrace = false;
  let endChar = -1;

  // Scan character by character through content from startChar
  for (let j = startChar; j < content.length; j++) {
    const ch = content[j];
    if (ch === "{") {
      depth++;
      foundOpenBrace = true;
    } else if (ch === "}") {
      if (foundOpenBrace) {
        depth--;
        if (depth === 0) {
          // Include the closing brace and any immediately following `;` or newline
          let end = j + 1;
          if (content[end] === ";") end++;
          // consume trailing newline so the replacement sits cleanly
          if (content[end] === "\n") end++;
          endChar = end;
          break;
        }
      }
    }
  }

  if (endChar === -1) {
    // No matching closing brace found — fallback: region is from startChar to end of file
    // This is a degenerate case; treat as not found to be fail-safe
    return null;
  }

  return { start: startChar, end: endChar };
}

/**
 * Apply a PatchBlock to in-memory `content`. Returns ApplyResult.
 * NEVER performs I/O; fail-safe — any ambiguity or not-found → error result.
 */
export function applyPatchBlock(block: PatchBlock, content: string): ApplyResult {
  const { filePath, replacement } = block;

  const region = locateFunctionRegion(content, replacement);

  if (region === null) {
    return {
      filePath,
      status: "not_found",
      error: `PATCH anchor not found in ${filePath}: no line matching the first line of the replacement block`,
    };
  }

  if ("ambiguous" in region) {
    return {
      filePath,
      status: "ambiguous",
      error: `PATCH anchor is ambiguous in ${filePath}: multiple lines match the first line of the replacement block`,
    };
  }

  const { start, end } = region;
  const newContent = content.slice(0, start) + replacement + content.slice(end);
  const diff = generateDiff(content, newContent, filePath);

  return {
    filePath,
    status: "applied",
    diff,
    originalContent: content,
    newContent,
  };
}

// ---------------------------------------------------------------------------
// Convert PatchBlock → EditBlock for unified applyBatch flow
// ---------------------------------------------------------------------------

/**
 * Wrap a PatchBlock in the EditBlock union so the existing applyBatch loop
 * can dispatch on it without restructuring.
 */
export function patchBlockToEditBlock(pb: PatchBlock): EditBlock {
  // We encode the PatchBlock data into the EditBlock fields:
  //   search  = "\x00PATCH\x00" + functionName (sentinel prefix, never valid file content)
  //   replace = pb.replacement
  //   format  = "patch-function"
  return {
    filePath: pb.filePath,
    search: `\x00PATCH\x00${pb.functionName}`,
    replace: pb.replacement,
    format: "patch-function",
  };
}
