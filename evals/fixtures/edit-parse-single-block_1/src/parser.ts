export function parseEditBlock(response: string): { filePath: string; search: string; replace: string } | null {
  // Format: <<<<<<< SEARCH\n<filePath>\n=======\n<search>\n>>>>>>> REPLACE\n<replace>
  const match = response.match(/<<<<<<< SEARCH\n(.+?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE\n([\s\S]*?)(?:\n|$)/);
  if (!match) return null;
  return {
    filePath: match[1]!.trim(),
    search: match[2]!,
    replace: match[3]!,
  };
}
