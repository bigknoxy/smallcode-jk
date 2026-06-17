export function isSafePath(filePath: string): boolean {
  if (filePath.startsWith('/')) return false;
  if (filePath.includes('../')) return false;
  return true;
}
