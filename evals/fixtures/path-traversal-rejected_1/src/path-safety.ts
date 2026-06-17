import { resolve, relative } from "node:path";

export function resolveSafe(root: string, filePath: string): string {
  const abs = resolve(root, filePath);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || !abs.startsWith(root)) {
    throw new Error(`Path not allowed: ${filePath} escapes root`);
  }
  return abs;
}
