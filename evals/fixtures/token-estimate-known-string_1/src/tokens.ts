export function estimateTokens(text: string): number {
  if (text.length === 0) return 1;
  return Math.ceil(text.length / 4);
}
