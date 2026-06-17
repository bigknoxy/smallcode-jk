import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { extractSymbols } from "./extractor.ts";
import type { FileMap, RepoMap } from "./types.ts";

export interface WalkOptions {
  root: string;
  ignore?: string[]; // glob-like patterns (e.g. ["node_modules", ".git", "dist"])
  maxFileSizeBytes?: number; // skip files larger than this (default: 512KB)
  extensions?: string[]; // only include these (default: common code extensions)
}

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "coverage",
  ".bun",
  "*.lock",
  "bun.lock",
];

const DEFAULT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".c",
  ".cpp",
  ".h",
];

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512KB
const BINARY_CHECK_BYTES = 512;

const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
};

function matchesIgnorePattern(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Glob-like: if pattern starts/ends with *, do a simple wildcard match
    if (pattern.startsWith("*")) {
      const suffix = pattern.slice(1);
      if (name.endsWith(suffix)) return true;
    } else if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (name.startsWith(prefix)) return true;
    } else {
      if (name === pattern) return true;
    }
  }
  return false;
}

function detectLanguage(ext: string): string {
  return EXTENSION_LANGUAGE[ext] ?? "unknown";
}

function isBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function walkDir(
  dir: string,
  root: string,
  ignore: string[],
  extensions: Set<string>,
  maxSize: number,
): Promise<FileMap[]> {
  let results: FileMap[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Skip ignored names
    if (matchesIgnorePattern(entry, ignore)) continue;

    const fullPath = join(dir, entry);
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (fileStat.isDirectory()) {
      const nested = await walkDir(fullPath, root, ignore, extensions, maxSize);
      results = results.concat(nested);
      continue;
    }

    if (!fileStat.isFile()) continue;

    const ext = extname(entry).toLowerCase();
    if (!extensions.has(ext)) continue;
    if (fileStat.size > maxSize) continue;

    // Read file as buffer first to check for binary
    let buffer: Buffer;
    try {
      buffer = await readFile(fullPath);
    } catch {
      continue;
    }

    if (isBinary(buffer)) continue;

    const content = buffer.toString("utf-8");

    // Relative path, always forward slashes
    const relPath = relative(root, fullPath).split(sep).join("/");
    const language = detectLanguage(ext);
    const symbols = extractSymbols(fullPath, content, language);
    const lineCount = content.split("\n").length;

    results.push({
      path: relPath,
      language,
      symbols,
      lineCount,
      sizeBytes: fileStat.size,
    });
  }

  return results;
}

export async function walkRepo(options: WalkOptions, now: number): Promise<RepoMap> {
  const {
    root,
    ignore = DEFAULT_IGNORE,
    maxFileSizeBytes = MAX_FILE_SIZE_BYTES,
    extensions = DEFAULT_EXTENSIONS,
  } = options;

  const extSet = new Set(extensions.map((e) => e.toLowerCase()));

  const files = await walkDir(root, root, ignore, extSet, maxFileSizeBytes);

  const totalSymbols = files.reduce((sum, f) => sum + f.symbols.length, 0);

  return {
    root,
    files,
    totalSymbols,
    builtAt: now,
  };
}
