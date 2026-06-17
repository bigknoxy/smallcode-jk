import type { ModelProfile } from "../../models/types.ts";
import type { Provider } from "../../provider/types.ts";
import type { GraderResult, GraderVerdict, LLMRubricGrader, Transcript } from "../types.ts";

// ---------------------------------------------------------------------------
// LLM rubric grader — calls the judge model once per dimension
// ---------------------------------------------------------------------------

export interface LLMJudgeOptions {
  provider: Provider;
  modelId: string;
  profile: ModelProfile;
}

const SYSTEM_PROMPT =
  "You are an impartial code reviewer. Grade ONLY the dimension specified. Do not consider other aspects.";

function buildUserPrompt(
  rubric: string,
  dimension: string | null,
  transcriptSummary: string,
): string {
  const dimLine = dimension ? `\n\nDimension to grade: ${dimension}` : "";
  return (
    `Rubric:\n${rubric}` +
    dimLine +
    `\n\nTranscript (last 3 turns):\n${transcriptSummary}` +
    `\n\nRespond with exactly:\nVerdict: PASS, FAIL, or UNKNOWN\nScore: 0.0–1.0\nReason: one sentence.`
  );
}

function summarizeTranscript(transcript: Transcript): string {
  const turns = transcript.turns.slice(-3);
  return turns
    .map(
      (t) =>
        `Turn ${t.turn}:\nPrompt: ${t.prompt.slice(0, 300)}\nAnswer: ${t.answer.slice(0, 300)}`,
    )
    .join("\n\n---\n\n");
}

interface JudgeScore {
  verdict: GraderVerdict;
  score: number;
  reason: string;
}

function parseJudgeResponse(response: string): JudgeScore {
  const verdictMatch = response.match(/Verdict:\s*(PASS|FAIL|UNKNOWN)/i);
  const scoreMatch = response.match(/Score:\s*([0-9]*\.?[0-9]+)/);
  const reasonMatch = response.match(/Reason:\s*(.+)/i);

  const rawVerdict = verdictMatch?.[1]?.toUpperCase() ?? "UNKNOWN";
  const rawScore = scoreMatch?.[1] ? parseFloat(scoreMatch[1]) : 0.5;
  const reason = reasonMatch?.[1]?.trim() ?? "No reason provided";

  let verdict: GraderVerdict;
  let score: number;

  switch (rawVerdict) {
    case "PASS":
      verdict = "pass";
      score = Math.max(0, Math.min(1, rawScore));
      break;
    case "FAIL":
      verdict = "fail";
      score = Math.max(0, Math.min(1, rawScore));
      break;
    default:
      verdict = "unknown";
      score = 0.5;
      break;
  }

  return { verdict, score, reason };
}

export async function runLLMGrader(
  grader: LLMRubricGrader,
  transcript: Transcript,
  _trialDir: string,
  opts: LLMJudgeOptions,
): Promise<GraderResult> {
  const startMs = Date.now();

  try {
    const transcriptSummary = summarizeTranscript(transcript);
    const dimensions =
      grader.dimensions && grader.dimensions.length > 0 ? grader.dimensions : [null];

    const judgeScores: JudgeScore[] = [];
    const outputLines: string[] = [];

    for (const dimension of dimensions) {
      const userPrompt = buildUserPrompt(grader.rubric, dimension, transcriptSummary);

      const response = await opts.provider.complete({
        model: opts.modelId,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: opts.profile.samplingDefaults.max_tokens,
      });

      const judgeScore = parseJudgeResponse(response.rawContent);
      judgeScores.push(judgeScore);

      const dimLabel = dimension ?? "overall";
      outputLines.push(
        `[${dimLabel}] Verdict: ${judgeScore.verdict}, Score: ${judgeScore.score.toFixed(2)}, Reason: ${judgeScore.reason}`,
      );
    }

    // Average scores across dimensions
    const avgScore = judgeScores.reduce((acc, s) => acc + s.score, 0) / judgeScores.length;

    // Determine overall verdict
    let verdict: GraderVerdict;
    const hasUnknown = judgeScores.some((s) => s.verdict === "unknown");
    const hasFail = judgeScores.some((s) => s.verdict === "fail");
    const allPass = judgeScores.every((s) => s.verdict === "pass");

    if (allPass) {
      verdict = "pass";
    } else if (hasFail) {
      verdict = "fail";
    } else if (hasUnknown) {
      verdict = "unknown";
    } else {
      verdict = "partial";
    }

    const output = outputLines.join("\n");
    const truncated = output.length > 2000 ? `${output.slice(0, 2000)}\n...[truncated]` : output;

    return {
      type: "llm_rubric",
      verdict,
      score: avgScore,
      output: truncated,
      durationMs: Date.now() - startMs,
      details: { dimensions: dimensions.map((d) => d ?? "overall"), judgeScores },
    };
  } catch (err) {
    return {
      type: "llm_rubric",
      verdict: "error",
      score: 0,
      output: String(err),
      durationMs: Date.now() - startMs,
      details: { error: String(err) },
    };
  }
}
