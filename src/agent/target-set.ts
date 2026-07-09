// Multi-file target set (opt-in, SMALLCODE_TARGET_SET). The single-file
// target-lock corrals a run onto ONE pinned file — correct for the common
// single-file bug, fatal for a fix that genuinely spans a function and the
// helper module it calls. This module computes the BOUNDED, wander-safe set of
// files such a fix is allowed to touch: the pinned primary target plus the
// source files it DIRECTLY imports (one hop). It reuses the import extractor
// from the import-gate so the two can never drift on what "an import" is.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import type { ContextChunk } from "@/context/types.ts";
import { estimateTokens } from "@/context/tokens.ts";
import { isOnTargetPath } from "@/edit/index.ts";
import { extractImportSpecifiers, isRelativeSpecifier } from "@/verify/import-check.ts";

/** Normalize a path to repo-relative POSIX form for comparison/display. */
function toRepoRel(abs: string, repoRoot: string): string {
  return relative(repoRoot, abs).replace(/\\/g, "/");
}

/** A source file that may hold a coupled bug: not a test/spec, not a dependency. */
function isEditableSource(rel: string): boolean {
  if (rel.startsWith("..") || isAbsolute(rel)) return false; // escaped the repo
  if (rel.includes("node_modules/")) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(rel)) return false;
  return true;
}

/**
 * The editable neighborhood for `primaryRel` (repo-relative). Returns the
 * primary first, then each directly-imported local source file that resolves
 * to a real repo file, deduped, capped at `maxNeighbors` (default 4) so the set
 * stays bounded no matter how many imports a file has. Pure of the model — a
 * deterministic function of the repo on disk. Falls back to just the primary on
 * any read/resolve failure (never throws), so a bad target degrades to today's
 * single-file behavior rather than crashing the loop.
 */
export async function computeEditableSet(
  primaryRel: string,
  repoRoot: string,
  maxNeighbors = 4,
): Promise<string[]> {
  const set = [primaryRel];
  const seen = new Set([primaryRel]);
  const primaryAbs = `${repoRoot}/${primaryRel}`;
  let source: string;
  try {
    const f = Bun.file(primaryAbs);
    if (!(await f.exists())) return set;
    source = await f.text();
  } catch {
    return set;
  }

  for (const spec of extractImportSpecifiers(source)) {
    if (set.length >= maxNeighbors + 1) break;
    if (!isRelativeSpecifier(spec)) continue; // npm/builtin deps are never editable
    let absNeighbor: string;
    try {
      absNeighbor = Bun.resolveSync(spec, dirname(primaryAbs));
    } catch {
      continue; // unresolvable import — skip, don't invent a file
    }
    const rel = toRepoRel(absNeighbor, repoRoot);
    if (!isEditableSource(rel) || seen.has(rel) || !existsSync(absNeighbor)) continue;
    seen.add(rel);
    set.push(rel);
  }
  return set;
}

/** True when `path` matches any file in the editable set (delegates the
 *  typo-tolerant comparison to the caller-supplied matcher, keeping this module
 *  free of edit-layer dependencies). */
export function isInEditableSet(
  path: string,
  set: readonly string[],
  matches: (a: string, b: string) => boolean,
): boolean {
  return set.some((t) => matches(path, t));
}

/**
 * Ensure every NEIGHBOR in the editable set is present in the context as a
 * whole-file `pinned` chunk. The primary (index 0) is already pinned by the
 * context builder; the neighbors are not, so without this the prompt's "edit
 * these files, their contents are in Relevant Context" claim can be false (a
 * low-relevance neighbor is never scored in, or is evicted as the largest
 * UNpinned chunk under window pressure) and the model is asked to blind-emit a
 * file it cannot see. Reads each neighbor and replaces any partial/windowed
 * chunk for it with the full pinned file. Mutates `chunks` in place. Best-effort
 * per file (an unreadable neighbor is simply skipped).
 */
export async function pinNeighborsIntoContext(
  chunks: ContextChunk[],
  editablePaths: readonly string[],
  readFile: (path: string) => Promise<string | null>,
): Promise<void> {
  for (let i = 1; i < editablePaths.length; i++) {
    const rel = editablePaths[i]!;
    const content = await readFile(rel);
    if (content === null) continue;
    // Drop any existing (possibly windowed) chunk for this file, then re-add the
    // whole file as pinned so the model sees complete, never-shed content.
    for (let j = chunks.length - 1; j >= 0; j--) {
      if (isOnTargetPath(chunks[j]!.filePath, rel)) chunks.splice(j, 1);
    }
    chunks.push({
      filePath: rel,
      startLine: 1,
      endLine: content.split("\n").length,
      content,
      estimatedTokens: estimateTokens(content),
      pinned: true,
    });
  }
}
