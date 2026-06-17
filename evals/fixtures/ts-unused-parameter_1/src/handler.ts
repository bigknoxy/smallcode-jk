export function handleRequest(req: { url: string }, _ctx: { userId: string }): string {
  return `Handling: ${req.url}`;
}
