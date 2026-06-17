export function applyEdit(
  files: Map<string, string>,
  filePath: string,
  search: string,
  replace: string,
): Map<string, string> {
  if (search === "") {
    files.set(filePath, replace);
  } else {
    const current = files.get(filePath) ?? "";
    const updated = current.replace(search, replace);
    files.set(filePath, updated);
  }
  return files;
}
