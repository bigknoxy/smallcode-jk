import { scoreFiles } from "./scorer.ts";
import { estimateTokens } from "./tokens.ts";
import type { CodeSymbol, ContextBundle, ContextChunk, FileMap, RepoMap } from "./types.ts";

export interface BuildOptions {
  repoRoot: string;
  tokenBudget: number;
  reserveTokens?: number;
  maxChunksPerFile?: number;
  includeSymbolsOnly?: boolean;
}

// Build a compact symbol-only text for a single file.
function buildSymbolOnlyText(fileMap: FileMap): string {
  if (fileMap.symbols.length === 0) {
    return `${fileMap.path}:\n  (no symbols)\n`;
  }

  const lines: string[] = [`${fileMap.path}:`];

  for (const sym of fileMap.symbols) {
    if (sym.kind === "method") {
      lines.push(`    ${sym.kind} ${sym.signature ?? sym.name}`);
    } else {
      lines.push(`  ${sym.kind} ${sym.signature ?? sym.name}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// Extract a line range from file content (1-based, inclusive), clamped to actual lines.
function extractLineRange(
  lines: string[],
  startLine: number,
  endLine: number,
): { start: number; end: number; content: string } {
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, endLine);
  const content = lines.slice(start - 1, end).join("\n");
  return { start, end, content };
}

// Compute a window around matched symbols ±20 lines.
function symbolWindow(
  matchedSymbols: CodeSymbol[],
  lineCount: number,
): { startLine: number; endLine: number } {
  if (matchedSymbols.length === 0) {
    return { startLine: 1, endLine: Math.min(40, lineCount) };
  }

  let minLine = Infinity;
  let maxLine = -Infinity;

  for (const sym of matchedSymbols) {
    minLine = Math.min(minLine, sym.line);
    maxLine = Math.max(maxLine, sym.endLine);
  }

  const startLine = Math.max(1, minLine - 20);
  const endLine = Math.min(lineCount, maxLine + 20);
  return { startLine, endLine };
}

export async function buildContext(
  repoMap: RepoMap,
  query: string,
  options: BuildOptions,
): Promise<ContextBundle> {
  const {
    repoRoot,
    tokenBudget,
    reserveTokens = 2048,
    maxChunksPerFile = 3,
    includeSymbolsOnly = false,
  } = options;

  const effectiveBudget = tokenBudget - reserveTokens;
  let remaining = effectiveBudget;
  let totalTokens = 0;
  let truncated = false;
  const chunks: ContextChunk[] = [];

  if (repoMap.files.length === 0) {
    const bundle: ContextBundle = {
      chunks: [],
      totalTokens: 0,
      tokenBudget,
      truncated: false,
      query,
    };
    return bundle;
  }

  const scoredFiles = scoreFiles(repoMap.files, query);

  if (includeSymbolsOnly) {
    // Build compact repo map from symbol signatures — no file reads.
    for (const { fileMap } of scoredFiles) {
      const text = buildSymbolOnlyText(fileMap);
      const tokens = estimateTokens(text);

      if (tokens > remaining) {
        truncated = true;
        break;
      }

      chunks.push({
        filePath: fileMap.path,
        startLine: 1,
        endLine: fileMap.lineCount,
        content: text,
        estimatedTokens: tokens,
      });

      totalTokens += tokens;
      remaining -= tokens;
    }

    const bundle: ContextBundle = {
      chunks,
      totalTokens,
      tokenBudget,
      truncated,
      query,
    };

    if (bundle.totalTokens > tokenBudget) {
      throw new Error(
        `Assertion failed: totalTokens (${bundle.totalTokens}) exceeds tokenBudget (${tokenBudget})`,
      );
    }

    return bundle;
  }

  // Full content mode: read files from disk.
  for (const { fileMap, matchedSymbols } of scoredFiles) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const absPath = `${repoRoot}/${fileMap.path}`;
    let fileContent: string;

    try {
      fileContent = await Bun.file(absPath).text();
    } catch {
      console.warn(`[context/builder] skipping missing file: ${absPath}`);
      continue;
    }

    const fileLines = fileContent.split("\n");
    const fileTokens = estimateTokens(fileContent);

    let chunksAdded = 0;

    if (fileTokens <= remaining) {
      // Include full file as a single chunk.
      chunks.push({
        filePath: fileMap.path,
        startLine: 1,
        endLine: fileLines.length,
        content: fileContent,
        estimatedTokens: fileTokens,
      });

      totalTokens += fileTokens;
      remaining -= fileTokens;
      chunksAdded++;
    } else {
      // Extract windows around matched symbols.
      const window = symbolWindow(matchedSymbols, fileLines.length);
      const { start, end, content } = extractLineRange(fileLines, window.startLine, window.endLine);
      const windowTokens = estimateTokens(content);

      if (windowTokens <= remaining && chunksAdded < maxChunksPerFile) {
        chunks.push({
          filePath: fileMap.path,
          startLine: start,
          endLine: end,
          content,
          estimatedTokens: windowTokens,
        });

        totalTokens += windowTokens;
        remaining -= windowTokens;
        chunksAdded++;
      } else {
        truncated = true;
      }
    }
  }

  const bundle: ContextBundle = {
    chunks,
    totalTokens,
    tokenBudget,
    truncated,
    query,
  };

  if (bundle.totalTokens > tokenBudget) {
    throw new Error(
      `Assertion failed: totalTokens (${bundle.totalTokens}) exceeds tokenBudget (${tokenBudget})`,
    );
  }

  return bundle;
}
