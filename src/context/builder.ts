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
 * Choose the function a PATCH should target.
 *
 * The query usually NAMES the buggy function ("fix wrapText…") — an EXACT
 * name-token match is the strongest signal and wins outright. When NO function
 * is exactly named by the query (an anonymous `export default function`, or a bug
 * described by behaviour rather than name), fall back to BODY-CONTENT relevance:
 * the function whose body contains the most distinct query terms is where the bug
 * lives. A weak substring name match (`toVal` ⊇ "val") is deliberately NOT trusted
 * on its own — that is exactly what mis-targeted a 9-line helper over the real
 * 100-line parser on the mri fixture. Scans ALL function symbols (with bodies),
 * not just the pre-filtered name-matched set, so the right target is always in
 * the candidate pool.
 */
export function pickTargetFunction(
  symbols: CodeSymbol[],
  content: string,
  query: string,
): string | undefined {
  const fns = symbols.filter((s) => s.kind === "function" || s.kind === "method");
  if (fns.length === 0) return undefined;
  const lines = content.split("\n");
  const tokens = [
    ...new Set(
      query
        .split(/[^a-zA-Z0-9_]/)
        .filter((t) => t.length >= 3)
        .map((t) => t.toLowerCase()),
    ),
  ];
  if (tokens.length === 0) return undefined;

  // Structural signal FIRST — query-INDEPENDENT. The per-turn query is the
  // planner's model-generated goal text, which may not carry the bug's terms;
  // relying on it alone re-introduced the mri mis-target. When ONE function
  // dominates the file (covers most of it and dwarfs the next-largest), the bug is
  // almost certainly inside it — target it regardless of the query. This is the
  // common real-repo shape: a module whose default export IS the implementation
  // (mri, klona, dequal). Checked before name match so a coincidental query word
  // matching a tiny helper (dequal's `find`) can't override the real parser.
  const sized = fns
    .map((s) => ({ sym: s, span: s.endLine - s.line + 1 }))
    .sort((a, b) => b.span - a.span);
  const nonBlank = lines.filter((l) => l.trim() !== "").length || lines.length;
  const top = sized[0]!;
  const second = sized[1];
  const dominates =
    top.span >= nonBlank * 0.5 && (second === undefined || top.span >= second.span * 2);
  if (dominates) return top.sym.name;

  // An EXACT name match anywhere in the query is the next strongest signal — the
  // bug explicitly named its function (the edit-reliability multi-function case).
  for (const sym of fns) {
    if (tokens.includes(sym.name.toLowerCase())) return sym.name;
  }

  // Otherwise rank by BODY-CONTENT relevance (multi-function files where no single
  // function dominates — e.g. a utils file with several similar-sized helpers).
  let best: CodeSymbol | undefined;
  let bestScore = -1;
  for (const sym of fns) {
    const body = lines
      .slice(Math.max(0, sym.line - 1), sym.endLine)
      .join("\n")
      .toLowerCase();
    let bodyHits = 0;
    for (const t of tokens) {
      if (body.includes(t)) bodyHits += 1;
    }
    // Faint size tiebreak; never overrides a real content difference.
    const sizeBias = Math.min((sym.endLine - sym.line) / 1000, 0.5);
    const score = bodyHits + sizeBias;
    if (score > bestScore) {
      bestScore = score;
      best = sym;
    }
  }
  // Require ≥1 body term — else leave undefined so the caller keeps whole-file
  // mode rather than aiming at an arbitrary function.
  return bestScore >= 1 ? best?.name : undefined;
}

/**
 * Multi-file decoy disambiguation. When several source files export the same
 * function name (e.g. the dequal repo ships `src/index.js`, `src/lite.js`, and
 * `src/alts.js`, all exporting a `dequal`-family fn), lexical scoring ties and
 * the pin loop may aim at a decoy. The tests only exercise ONE of them — the
 * file they import — and that is the real edit target. We recover the imported
 * file(s) by parsing the relative import specifiers out of the repo's test
 * files and resolving them to repo-relative source paths.
 *
 * Pure string/path work — no disk reads beyond the test contents already passed
 * in. Single-file repos yield an empty set, so this layer is a no-op there.
 */
function normalizeRel(path: string): string {
  // Collapse `./` and `../` segments; forward-slashes only (walker guarantees).
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Resolve a relative import specifier (from a file at `fromPath`) to the set of
 * candidate repo-relative source paths it could denote. Mirrors Node/Bun module
 * resolution loosely: strips a `.js`/`.mjs` extension that may actually map to a
 * `.ts` source, tries the literal path, common source extensions, and an
 * `/index.*` directory entry. Returns every plausible repo-relative form so the
 * caller can match against the actual files present.
 */
function resolveImportCandidates(fromPath: string, spec: string): string[] {
  if (!spec.startsWith(".")) return []; // bare specifier (a dependency) — not in-repo
  const base = normalizeRel(`${dirOf(fromPath)}/${spec}`);
  const exts = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];
  const out = new Set<string>([base]);
  // `import "./x.js"` frequently resolves to `./x.ts` in a TS repo.
  const dot = base.lastIndexOf(".");
  const slash = base.lastIndexOf("/");
  const hasExt = dot > slash;
  if (hasExt) {
    const stem = base.slice(0, dot);
    for (const e of exts) out.add(`${stem}.${e}`);
  } else {
    for (const e of exts) out.add(`${base}.${e}`);
    for (const e of exts) out.add(`${base}/index.${e}`);
  }
  return [...out];
}

const IMPORT_SPEC_RE =
  /(?:import|export)[^'"`]*?from\s*["'`]([^"'`]+)["'`]|(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

/**
 * Collect the repo-relative source paths that the repo's TEST files import.
 * These are the files actually under test — the correct edit targets — and take
 * priority over same-named decoys in the pin loop.
 */
async function findTestImportedPaths(repoMap: RepoMap, repoRoot: string): Promise<Set<string>> {
  const present = new Set(repoMap.files.map((f) => f.path));
  const imported = new Set<string>();
  const testFiles = repoMap.files.filter((f) => isTestPath(f.path));
  for (const tf of testFiles) {
    let content: string;
    try {
      content = await Bun.file(`${repoRoot}/${tf.path}`).text();
    } catch {
      continue;
    }
    IMPORT_SPEC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_SPEC_RE.exec(content)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      for (const cand of resolveImportCandidates(tf.path, spec)) {
        if (present.has(cand)) imported.add(cand);
      }
    }
  }
  return imported;
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
    let candidates = scoredFiles.filter((s) => s.score > 0 && !isTestPath(s.fileMap.path));
    // Decoy tie-breaker: when MORE than one source file could be the target
    // (the only case this matters — single-candidate repos are unaffected),
    // prefer the file(s) the tests actually import. This is a TRUE tie-break —
    // it reorders ONLY within the top score tier, so it can promote an
    // import-backed file above an equally-scored decoy but NEVER above a
    // strictly higher-scored winner. Restricting to the top tier is what stops
    // a test-imported barrel/wrapper (e.g. src/index.js re-exporting parseLine)
    // from demoting the lower-level module that actually DEFINES the buggy
    // function and carries the dominant PATH_MENTION score (src/lexer.js).
    if (candidates.length > 1) {
      const imported = await findTestImportedPaths(repoMap, repoRoot);
      if (imported.size > 0) {
        const topScore = candidates[0]!.score; // candidates are score-sorted desc
        const topTier = candidates.filter((c) => c.score === topScore);
        if (topTier.length > 1) {
          const lower = candidates.filter((c) => c.score !== topScore);
          const inTests = topTier.filter((c) => imported.has(c.fileMap.path));
          const rest = topTier.filter((c) => !imported.has(c.fileMap.path));
          if (inTests.length > 0) candidates = [...inTests, ...rest, ...lower];
        }
      }
    }
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
      const functionName = pickTargetFunction(cand.fileMap.symbols, content, query);
      const targetSym = functionName
        ? cand.fileMap.symbols.find((s) => s.name === functionName)
        : undefined;
      const functionLineCount = targetSym ? targetSym.endLine - targetSym.line + 1 : undefined;
      targetFile = {
        path: cand.fileMap.path,
        lineCount: cand.fileMap.lineCount,
        format: chooseEditFormat(cand.fileMap.lineCount),
        ...(functionName ? { functionName } : {}),
        ...(functionLineCount !== undefined ? { functionLineCount } : {}),
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
