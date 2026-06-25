import { chooseEditFormat } from "@/edit/patch-function.ts";
import { scoreFiles } from "./scorer.ts";
import { estimateTokens } from "./tokens.ts";
import type {
  CodeSymbol,
  ContextBundle,
  ContextChunk,
  FileMap,
  RepoMap,
  TargetFile,
} from "./types.ts";

/** Test/spec files are never edit targets — the model fixes the source under test. */
function isTestPath(path: string): boolean {
  return /(?:\.test\.|\.spec\.|(?:^|\/)tests?\/|(?:^|\/)__tests__\/)/i.test(path);
}

/**
 * A barrel/re-export file (e.g. `index.ts` doing `export * from "./x"`) is never
 * an edit target — the implementation lives in the modules it re-exports, not
 * here. The symbol extractor lists every re-exported name as a symbol, so a
 * barrel matches every query token and would out-score the real source file.
 * Heuristic: of the non-blank, non-comment lines, the majority are re-exports.
 */
function isBarrelFile(content: string): boolean {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/\s+/g, " ") // collapse newlines so multi-line export lists are one statement
    .trim();
  if (!stripped) return false;
  // Strip every re-export statement: `export * from`, `export * as ns from`,
  // `export { a, b, type C } from`, `export type { T } from`.
  const remainder = stripped
    .replace(
      /export\s+(?:\*(?:\s+as\s+\w+)?|type\s+\{[^}]*\}|\{[^}]*\})\s+from\s+["'][^"']+["']\s*;?/g,
      " ",
    )
    .trim();
  // Barrel iff at least one re-export existed and nothing else remains.
  return remainder.length === 0 && remainder !== stripped;
}

/**
 * Choose the function a PATCH should target: the matched symbol whose name most
 * strongly matches the query. Prefer an exact token match (the bug usually names
 * its function) over a weak substring match — otherwise a 2-char query token
 * like "to" matches `tokenize` ahead of the intended `toKebab`.
 */
function pickFunctionName(matched: CodeSymbol[], query: string): string | undefined {
  if (matched.length === 0) return undefined;
  const tokens = query
    .split(/[^a-zA-Z0-9_]/)
    .filter((t) => t.length >= 2)
    .map((t) => t.toLowerCase());
  let best: CodeSymbol | undefined;
  let bestScore = -1;
  for (const sym of matched) {
    const name = sym.name.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (name === t) score += 10;
      else if (name.includes(t)) score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      best = sym;
    }
  }
  return best?.name;
}

export interface BuildOptions {
  repoRoot: string;
  tokenBudget: number;
  reserveTokens?: number;
  maxChunksPerFile?: number;
  includeSymbolsOnly?: boolean;
  /**
   * Pin the edit target as an undroppable whole chunk + set bundle.targetFile
   * (Option A). Default true. Set false to measure the pre-A baseline on the
   * identical retrieval path (clean A/B isolation).
   */
  pinTarget?: boolean;
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
    pinTarget = true,
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

  // Identify the edit target: the highest-scored non-test source file with a
  // real lexical match. The model MUST see this file in full to edit it, so it
  // is emitted as a whole PINNED chunk (never windowed, never shed) ahead of the
  // peripheral context — even when that overruns the retrieval budget, because a
  // file the model can't see in full is a guaranteed truncated/hallucinated
  // edit. Its size deterministically selects the edit format downstream
  // (whole-file FILE: vs single-function PATCH:).
  let targetFile: TargetFile | undefined;
  if (pinTarget) {
    // Walk score-ranked candidates (non-test, real match) and pick the first
    // that defines implementation — skipping barrels that merely re-export. The
    // winner's content is read here for pinning, so scanning a few candidates is
    // cheap (we stop at the first real source file).
    const candidates = scoredFiles.filter((s) => s.score > 0 && !isTestPath(s.fileMap.path));
    for (const cand of candidates) {
      const targetAbs = `${repoRoot}/${cand.fileMap.path}`;
      let content: string;
      try {
        content = await Bun.file(targetAbs).text();
      } catch {
        continue;
      }
      if (isBarrelFile(content)) continue;

      const tokens = estimateTokens(content);
      chunks.push({
        filePath: cand.fileMap.path,
        startLine: 1,
        endLine: content.split("\n").length,
        content,
        estimatedTokens: tokens,
        pinned: true,
      });
      totalTokens += tokens;
      remaining -= tokens;
      const functionName = pickFunctionName(cand.matchedSymbols, query);
      targetFile = {
        path: cand.fileMap.path,
        lineCount: cand.fileMap.lineCount,
        format: chooseEditFormat(cand.fileMap.lineCount),
        ...(functionName ? { functionName } : {}),
      };
      break;
    }
  }

  // Full content mode: read files from disk.
  for (const { fileMap, matchedSymbols } of scoredFiles) {
    // The target file was already added in full above — never duplicate or
    // re-window it, regardless of remaining budget.
    if (targetFile && fileMap.path === targetFile.path) {
      continue;
    }
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
    ...(targetFile ? { targetFile } : {}),
  };

  // The pinned target is allowed to exceed the retrieval budget by design (the
  // true context-window cap is enforced later by fitTurnPromptToWindow). The
  // assertion still guards the budget-rationed (non-pinned) chunks against a
  // retrieval bug.
  const pinnedTokens = chunks.reduce((s, c) => s + (c.pinned ? c.estimatedTokens : 0), 0);
  if (bundle.totalTokens - pinnedTokens > tokenBudget) {
    throw new Error(
      `Assertion failed: budgeted tokens (${bundle.totalTokens - pinnedTokens}) exceeds tokenBudget (${tokenBudget})`,
    );
  }

  return bundle;
}
