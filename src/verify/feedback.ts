import type { VerifyResult } from "./types.ts";

export function formatVerifyFeedback(
  result: VerifyResult,
  iteration: number,
  maxIterations: number,
): string {
  if (result.passed) {
    return "All checks passed.";
  }

  const failures = result.checks.filter((c) => c.status === "failed" || c.status === "error");

  const sections = failures
    .map((c) => `### [${c.kind}] ${c.name}\n\`\`\`\n${c.output}\n\`\`\``)
    .join("\n\n");

  const isLastAttempt = iteration >= maxIterations;
  const footer = isLastAttempt
    ? `This is your LAST attempt. Fix what you can.\nThen call TOOL: finish {"summary": "fixed"}.`
    : `Fix ALL failures above, then call TOOL: finish {"summary": "fixed"}.\nDo not add new functionality — only fix what broke.`;

  return `## Verification failed (iteration ${iteration}/${maxIterations})

The following checks failed after your edits:

${sections}

${footer}`;
}
