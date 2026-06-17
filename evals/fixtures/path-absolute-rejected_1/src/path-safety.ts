import { resolve } from "node:path";

export function resolveSafe(root: string, filePath: string): string {
  if (filePath.startsWith('/')) {
    throw new Error(`Path not allowed: absolute path ${filePath}`);
  }
  const abs = resolve(root, filePath);
  if (!abs.startsWith(root)) {
    throw new Error(`Path not allowed: ${filePath} escapes root`);
  }
  return abs;
}
