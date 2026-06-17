import { resolve, relative } from "node:path";

export function resolveSafe(root: string, filePath: string): string {
  if (filePath.startsWith('/')) {
    throw new Error(`Path not allowed: absolute path`);
  }
  const abs = resolve(root, filePath);
  const rel = relative(root, abs);
  if (rel.startsWith('..')) {
    throw new Error(`Path not allowed: ${filePath} escapes root`);
  }
  return abs;
}
