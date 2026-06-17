export interface EditBlock {
  filePath: string;
  search: string;
  replace: string;
}

export function parseEditBlocks(response: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  // Split on "File: " lines to find each block
  const filePattern = /File:\s*(.+?)\n<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>>/g;
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(response)) !== null) {
    blocks.push({
      filePath: match[1]!.trim(),
      search: match[2]!,
      replace: match[3]!,
    });
  }
  return blocks;
}
