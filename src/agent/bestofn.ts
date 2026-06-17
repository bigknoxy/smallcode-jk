import { applyBatch } from "../edit/applier.ts";
import { parse as parseEdits } from "../edit/parser.ts";
import type { ApplyResult, EditBlock } from "../edit/types.ts";
import type { ModelProfile } from "../models/types.ts";
import type { CompletionRequest, Provider } from "../provider/types.ts";
import { ReasoningHandler } from "../reasoning/handler.ts";
import type { BestOfNResult, Candidate } from "./types.ts";

export interface BestOfNOptions {
  n: number;
  provider: Provider;
  profile: ModelProfile;
  repoRoot: string;
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<void>;
  runVerifier: () => Promise<{ checksRun: number; checksPassed: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCandidate(
  index: number,
  rawResponse: string,
  profile: ModelProfile,
): Omit<Candidate, "applyResults" | "checksRun" | "checksPassed" | "verifierScore"> {
  let reasoning: string | undefined;
  let answer: string;

  if (profile.reasoningTags) {
    const handler = new ReasoningHandler(profile.reasoningTags);
    const parsed = handler.parse(rawResponse);
    reasoning = parsed.reasoning ?? undefined;
    answer = parsed.answer;
  } else {
    answer = rawResponse;
  }

  const parseResult = parseEdits(answer);
  const editBlocks: EditBlock[] = parseResult.blocks;

  return { index, rawResponse, reasoning, answer, editBlocks };
}

// ---------------------------------------------------------------------------
// selectBestCandidate
// ---------------------------------------------------------------------------

export async function selectBestCandidate(
  request: CompletionRequest,
  opts: BestOfNOptions,
): Promise<BestOfNResult> {
  const { n, provider, profile, readFile, writeFile, runVerifier } = opts;

  // ------------------------------------------------------------------
  // Fast path: n === 1 — no scoring overhead
  // ------------------------------------------------------------------
  if (n === 1) {
    const resp = await provider.complete(request);
    const base = parseCandidate(0, resp.rawContent, profile);
    const candidate: Candidate = {
      ...base,
      applyResults: [],
      checksRun: 0,
      checksPassed: 0,
      verifierScore: 0,
    };
    return { winner: candidate, all: [candidate], n: 1 };
  }

  // ------------------------------------------------------------------
  // n > 1: generate all completions in parallel, then score sequentially
  // ------------------------------------------------------------------
  const responses = await Promise.all(Array.from({ length: n }, () => provider.complete(request)));

  const candidates: Candidate[] = [];

  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i]!;
    const base = parseCandidate(i, resp.rawContent, profile);

    // Collect original file contents for the files this candidate touches
    const touchedPaths = Array.from(new Set(base.editBlocks.map((b) => b.filePath)));
    const originals = new Map<string, string | null>();
    for (const p of touchedPaths) {
      originals.set(p, await readFile(p));
    }

    // Apply candidate edits to disk
    let applyResults: ApplyResult[] = [];
    if (base.editBlocks.length > 0) {
      const batchResult = await applyBatch(base.editBlocks, readFile, writeFile);
      applyResults = batchResult.results;
    }

    // Run verifier on current disk state
    const { checksRun, checksPassed } = await runVerifier();
    const verifierScore = checksPassed / Math.max(checksRun, 1);

    candidates.push({
      ...base,
      applyResults,
      checksRun,
      checksPassed,
      verifierScore,
    });

    // Revert — restore originals
    for (const [p, original] of originals) {
      if (original !== null) {
        await writeFile(p, original);
      } else {
        // File didn't exist before — best effort: write empty string to signal removal
        // (in practice, the verifier environment should handle new files gracefully)
        // We cannot delete with the injected writeFile, so we restore to empty
        await writeFile(p, "");
      }
    }
  }

  // Pick winner: highest verifierScore, ties broken by lowest index
  let winner = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.verifierScore > winner.verifierScore) {
      winner = c;
    }
  }

  // Apply winning candidate's edits to disk (final)
  if (winner.editBlocks.length > 0) {
    const batchResult = await applyBatch(winner.editBlocks, readFile, writeFile);
    // Update winner's applyResults with the final apply (re-apply on reverted state)
    winner = { ...winner, applyResults: batchResult.results };
  }

  return { winner, all: candidates, n };
}
