// Issue #95: eval run --save-transcripts — persist per-trial Transcripts to the
// TranscriptStore layout (<transcriptsDir>/<taskId>/<id>.json) so
// scripts/classify-pass-quality.ts has a real data source to read from.
//
// Pure persistence helper: takes whatever TaskEvalResult[] a runner already
// produced and writes each trial's transcript via TranscriptStore.save. No
// model/provider dependency, so it's trivially unit-testable and safe to call
// from both `smallcode eval run` (src/eval/cli.ts) and scripts/run-baseline.ts.
import type { TranscriptStore } from "./transcript-store.ts";
import type { TaskEvalResult, TrialResult } from "./types.ts";

/**
 * Saves every trial's transcript from a set of task results into `store`.
 * Returns the number of transcripts written. Accepts either full
 * TaskEvalResult[] (as returned by runSuite/runTask) or a bare TrialResult[]
 * for callers that already flattened trials.
 */
export async function saveTrialTranscripts(
  store: TranscriptStore,
  taskResults: TaskEvalResult[] | TrialResult[],
): Promise<number> {
  const trials: TrialResult[] = taskResults.flatMap((r) =>
    "trials" in r ? r.trials : [r],
  );

  let saved = 0;
  for (const trial of trials) {
    await store.save(trial.transcript);
    saved++;
  }
  return saved;
}
