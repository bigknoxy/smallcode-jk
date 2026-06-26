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

/**
 * Lines threshold above which the harness switches the target file to PATCH
 * (single-function) editing. Calibrated against the edit-reliability suite on a
 * 3B: a 30-line file is solved whole-file in 1 turn (1.00); 124/164-line files
 * fail whole-file emission (0.00–0.40) because the tail gets truncated. A k=1
 * smoke at threshold 140 confirmed the directly-PATCHed 164-line file jumped
 * 0.00→1.00 while the 125-line files left on whole-file emission did NOT
 * improve — so the gate must sit below 125. 80 keeps small files (the control)
 * whole while localizing anything substantial to one function the model can
 * reliably emit. Lowered 300 → 140 → 80.
 */
export const PATCH_LINE_THRESHOLD = 80;

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
 * Find lines that DEFINE `name` (not call it). Returns matching line indices.
 * Strong patterns first (`function name`, `const/let/var name =`); only if none
 * match do we accept a class-method-style `name(...) {` line (gated on a trailing
 * `{` to avoid call sites). Exported for testing.
 */
export function findDefinitionLines(contentLines: string[], name: string): number[] {
  // Synthetic name for an anonymous `export default function (…)` (the extractor
  // tags it "default"). Anchor on the default-export line itself, since there is
  // no identifier to match.
  if (name === "default") {
    const defaultRe = /^export\s+default\s+(?:async\s+)?function\b/;
    const hits: number[] = [];
    for (let i = 0; i < contentLines.length; i++) {
      if (defaultRe.test((contentLines[i] ?? "").trim())) hits.push(i);
    }
    return hits;
  }
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const strong = [
    new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${esc}\\b`),
    new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*[:=]`),
  ];
  const strongHits: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const t = (contentLines[i] ?? "").trim();
    if (strong.some((p) => p.test(t))) strongHits.push(i);
  }
  if (strongHits.length > 0) return strongHits;

  // Fallback: class method `name(args) {` — require trailing `{` so we don't
  // anchor on a call site like `padCell(x, y)`.
  const method = new RegExp(
    `^(?:public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|async\\s+|get\\s+|set\\s+|\\*\\s*)*${esc}\\s*\\(`,
  );
  const methodHits: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const t = (contentLines[i] ?? "").trim();
    if (method.test(t) && /\{\s*$/.test(t)) methodHits.push(i);
  }
  return methodHits;
}

/**
 * Locate the target function region in `content`. The anchor is the function's
 * DEFINITION located by NAME (`functionName`) — robust to a small model emitting
 * a signature that doesn't byte-match the source (different param names, types,
 * spacing). Falls back to matching the trimmed first non-empty line of
 * `replacement` only when name lookup finds nothing.
 *
 * Returns start/end character positions of the region, `{ambiguous:true}` if the
 * anchor is non-unique, or null if not found. The region ends at the closing
 * brace returning brace depth to 0 (handles top-level fns, class methods, and
 * `const x = () => {…}` arrows).
 */
function locateFunctionRegion(
  content: string,
  functionName: string,
  replacement: string,
): { start: number; end: number } | { ambiguous: true } | null {
  const contentLines = content.split("\n");

  // Primary anchor: the function's definition line, found by name.
  let matchIndices = functionName ? findDefinitionLines(contentLines, functionName) : [];

  // Fallback: the model's emitted first line (legacy behaviour) when the name
  // lookup yields nothing (e.g. unusual declaration style).
  if (matchIndices.length === 0) {
    const anchorLine = replacement.split("\n").find((l) => l.trim() !== "")?.trim();
    if (!anchorLine) return null;
    for (let i = 0; i < contentLines.length; i++) {
      if ((contentLines[i] ?? "").trim() === anchorLine) matchIndices.push(i);
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
 * Re-add a leading `export` (or `export default`) that the original function
 * had but the model's replacement dropped. Small models routinely paraphrase a
 * signature and silently lose the `export` keyword, turning the function private
 * and breaking every importer — a logically-correct fix that still fails the
 * tests. We know the original was exported (we just located it), so restore it.
 * Exported for testing.
 */
export function preserveExport(original: string, replacement: string): string {
  const origFirst = original.split("\n").find((l) => l.trim() !== "") ?? "";
  const origExport = /^\s*export\s+(default\s+)?/.exec(origFirst);
  if (!origExport) return replacement;

  const lines = replacement.split("\n");
  const idx = lines.findIndex((l) => l.trim() !== "");
  if (idx < 0) return replacement;
  if (/^\s*export\b/.test(lines[idx]!)) return replacement; // already exported

  const indent = /^(\s*)/.exec(lines[idx]!)?.[1] ?? "";
  const keyword = origExport[1] ? "export default " : "export ";
  lines[idx] = `${indent}${keyword}${lines[idx]!.trimStart()}`;
  return lines.join("\n");
}

/**
 * Apply a PatchBlock to in-memory `content`. Returns ApplyResult.
 * NEVER performs I/O; fail-safe — any ambiguity or not-found → error result.
 */
export function applyPatchBlock(block: PatchBlock, content: string): ApplyResult {
  const { filePath, functionName, replacement } = block;

  const region = locateFunctionRegion(content, functionName, replacement);

  if (region === null) {
    return {
      filePath,
      status: "not_found",
      error: `PATCH target not found in ${filePath}: no definition of function "${functionName}" (and no line matching the replacement's first line)`,
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
  const finalReplacement = preserveExport(content.slice(start, end), replacement);
  const newContent = content.slice(0, start) + finalReplacement + content.slice(end);
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
