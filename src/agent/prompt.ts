import { env } from "@/config/env.ts";
import { estimateTokens } from "@/context/tokens.ts";
import type { ContextBundle } from "@/context/types.ts";
import { ELISION_DETECTED, extractFunctionSource, TEST_FILE_EDIT_REJECTED } from "@/edit/index.ts";
import type { ModelProfile } from "@/models/types.ts";
import { renderDiagnostic } from "@/verify/failure-extract.ts";
import { defaultPromptSet } from "./prompt-set.ts";
import type { AgentConfig, AgentState } from "./types.ts";

export interface BuildTurnPromptOpts {
  /** When true, emit a REDRAFT section and suppress Recent History. */
  redraft?: boolean;
  /** Strategy hint appended to the REDRAFT section. */
  strategyHint?: string;
  /**
   * When true, emit an ANSWER-NOW section and suppress Recent History. Set on the
   * turn AFTER a think-only truncation: the model burned its whole generation
   * budget on reasoning and produced no answer. This prompt tells it to skip the
   * thinking and emit the FILE: block / TOOL: call immediately.
   */
  answerNow?: boolean;
}

// SMALLCODE_DIFF_EDIT switches PATCH (big-file) mode from "re-emit the complete
// function" to a minimal SEARCH/REPLACE diff. The forensics show coder models
// over-edit when asked for the whole function; a diff of only the changed lines
// fits their natural "show only the change" behaviour. The parser + fuzzy applier
// + repair pipeline already accept SEARCH/REPLACE. The A/B confirmed a net win
// (edit-reliability OVERALL 0.63 -> 0.80), so this is now DEFAULT ON. Opt OUT with
// SMALLCODE_DIFF_EDIT=0. The size gate (DIFF_MIN_FN_LINES) still confines it to
// LARGE target functions, so small-file FILE: mode is unaffected.
const DIFF_EDIT = env.diffEdit;
// Size gate: the minimal-diff format only pays off on LARGE target functions
// (where whole-function re-emission over-edits). On small functions whole-function
// PATCH already works and exact-match S/R only adds fragility (the edit-reliability
// A/B: wrapText 42ln 0.20→0.60 win; padCell 10ln 0.70→0.10 regression). Apply diff
// only when the target function is at least this many lines.
const DIFF_MIN_FN_LINES = env.diffMinFnLines;

export function buildSystemPrompt(_profile: ModelProfile, config: AgentConfig): string {
  // Delegate to promptSet if supplied; otherwise assemble the default set
  // (which preserves the disciplineRules toggle behaviour exactly).
  const ps = config.promptSet ?? defaultPromptSet({ disciplineRules: config.disciplineRules });

  // Append the ## SKILL block when the promptSet carries a non-empty skill string.
  // When skill is absent or empty, the output is byte-identical to the old behaviour.
  //
  // Note: the minimal-diff (SEARCH/REPLACE) instruction is NOT injected into the
  // system prompt. Now that DIFF_EDIT is default-ON, mutating the system prompt
  // here would (a) break the GEPA prompt-seam invariant — buildSystemPrompt must
  // return the promptSet's system verbatim so a mutated candidate carries cleanly
  // — and (b) be redundant: the per-turn "## Edit Target" directive in
  // buildTurnPrompt renders the literal SEARCH/REPLACE template and tells the
  // model to use it, and it fires ONLY when a large target function is actually
  // present (more precise than a blanket system rule). So the directive lives at
  // the turn level, keeping the system prompt single-source-of-truth.
  const system = ps.skill && ps.skill.trim().length > 0 ? `${ps.system}\n\n## SKILL\n${ps.skill}` : ps.system;
  return system;
}

export function buildTurnPrompt(
  state: AgentState,
  context: ContextBundle,
  opts?: BuildTurnPromptOpts,
): string {
  const goal = state.goals[state.currentGoalIndex];
  const turnNumber = state.turns.length + 1;

  const parts: string[] = [];

  parts.push(`## Task`);
  parts.push(state.task);

  parts.push(`\n## Current Action (step ${state.currentGoalIndex + 1}/${state.goals.length})`);
  parts.push(goal !== undefined ? goal.description : "No active goal.");
  parts.push("\nExecute this action NOW with a FILE: block or tool calls. Do not describe — act.");

  // Structured failure diagnostic from the most recent failing turn. This is the
  // strongest bug-LOCALIZATION signal a small model gets: a wrong operator /
  // off-by-one shows up as a specific expected≠received pair. qwen mechanically
  // emits a valid diff but edits the WRONG line when the assertion is buried, so
  // we render it HERE — above BOTH the "## Edit Target" mechanical directive AND
  // Recent History — and lead with the concrete mismatch so "WHAT to fix" lands
  // before "HOW to emit it". We do NOT fabricate line numbers; only the
  // oracle-provided expected/received/message are shown. Suppressed under
  // answerNow (no budget to reason) — there it would only re-trigger the
  // think-loop the answerNow prompt exists to break.
  const failingTurn = state.turns.at(-1);
  const renderFailure = failingTurn?.diagnostic && !opts?.answerNow;
  if (renderFailure) {
    const d = failingTurn!.diagnostic!;
    // R4: a load/compile error (missing module, parse error) means the code never
    // ran — there is no expected/received to localize. Lead with an unambiguous
    // BUILD ERROR directive so the model fixes the import/syntax instead of
    // re-emitting the same hallucinated module (the dogfood `std/strings` loop).
    const isBuildError =
      d.errorType === "module-load" ||
      d.errorType === "SyntaxError" ||
      (d.errorType?.startsWith("TS") ?? false) ||
      /Cannot find (?:module|package)|SyntaxError|Transpilation failed/i.test(d.message);
    if (isBuildError) {
      parts.push("\n## BUILD ERROR — your code does not compile/load");
      parts.push(
        "Your last edit did NOT run — the file failed to compile or an import could not be resolved, so NO test executed. Fix this first. Do NOT import modules that don't exist; use built-in JavaScript/TypeScript APIs (e.g. `String.prototype.replace`, `RegExp`). Re-check every `import` line.",
      );
      parts.push(renderDiagnostic(d));
    } else {
      parts.push("\n## FAILING TEST — fix exactly this");
      parts.push("**Failure (fix THIS):**");
      const hasValues = d.expected !== undefined || d.actual !== undefined;
      if (hasValues) {
        // Lead with a stark one-line mismatch — the localization anchor — BEFORE any
        // prose, so it is the first concrete thing the model reads. The arrow form
        // is intentionally distinct from renderDiagnostic's two-line Expected:/
        // Received: pair below, so the fact is reinforced, not duplicated verbatim.
        const exp = d.expected ?? "(no value)";
        const act = d.actual ?? "(no value)";
        parts.push(`The test wants \`${exp}\` but the code produces \`${act}\`.`);
        parts.push(
          "The bug is the single line whose value produces `Received` where the test wants `Expected`. Find and change ONLY that line so it yields `Expected`. Do not touch correct lines.",
        );
      }
      parts.push(renderDiagnostic(d));
    }
    // R2 externalize-localization: when the stack trace reached a source line, show
    // the exact failing line + a tight window. This hands the small model the
    // `where` it cannot localize itself — only set for runtime throws (a value
    // mismatch's trace stops at the test line and carries no location).
    if (failingTurn!.failureLocation) {
      const loc = failingTurn!.failureLocation;
      parts.push(`\n## FAILURE LOCATION — the error was thrown at \`${loc.file}:${loc.line}\``);
      parts.push("Fix the marked line (or what feeds it). Edit ONLY this region:");
      parts.push("```");
      parts.push(loc.window);
      parts.push("```");
    }
  }

  // Deterministic edit-format directive. The harness — not the model — decides
  // whole-file vs single-function editing based on the target file's size, and
  // states it explicitly so a small model never has to self-assess "is this file
  // large?" (it reliably gets that wrong). PATCH localizes the edit to one
  // function so the model emits ~15 lines instead of 160 it would truncate.
  const target = context.targetFile;
  if (target) {
    const usePatch = target.format === "patch" && target.functionName !== undefined;
    // Human-readable label for the edit target. The extractor names an anonymous
    // `export default function (…)` with the synthetic anchor "default" so the
    // PATCH applier can find it — but telling the model to edit "the `default`
    // function" names nothing it can see in the source (there is no `function
    // default`), which on real-repo default exports (mri, klona, dequal) reads as
    // an opaque instruction and costs localization confidence. Show prose the
    // model recognizes; keep the synthetic name only where the applier anchors on
    // it (the PATCH FUNCTION: line).
    const isDefaultExport = target.functionName === "default";
    const fnLabel = isDefaultExport
      ? "the file's `export default function` (its default export)"
      : `the \`${target.functionName}\` function`;
    parts.push(`\n## Edit Target — ${target.path} (${target.lineCount} lines)`);
    const useDiff =
      usePatch && DIFF_EDIT && (target.functionLineCount ?? 0) >= DIFF_MIN_FN_LINES;
    if (useDiff) {
      // Minimal SEARCH/REPLACE diff: change only the buggy lines of the target fn.
      parts.push(
        `This file is large. Make a MINIMAL edit to ${fnLabel}: emit a SEARCH/REPLACE block that changes ONLY the buggy line(s). Copy the SEARCH text BYTE-FOR-BYTE from the file shown in Relevant Context below (same indentation — tabs vs spaces — and punctuation). Output it as the FIRST thing in your reply, in exactly this shape — no preamble, no whole-function rewrite:`,
      );
      parts.push("```");
      parts.push(target.path);
      parts.push("<<<<<<< SEARCH");
      parts.push("(the exact current line(s) containing the bug)");
      parts.push("=======");
      parts.push("(the corrected line(s))");
      parts.push(">>>>>>> REPLACE");
      parts.push("```");
      parts.push(
        "Include only the lines that change; add ONE adjacent unchanged line if needed to make the SEARCH unique. Do NOT re-emit the whole function or file.",
      );
    } else if (usePatch) {
      parts.push(
        `This file is large — use PATCH: mode. Do NOT emit the whole file (it will be rejected). Edit ONLY ${fnLabel}. Output the PATCH block as the FIRST thing in your reply — do not think out loud, do not restate the task, just emit it in exactly this shape (replace the placeholder with the corrected function body):`,
      );
      parts.push("```");
      parts.push(`PATCH: ${target.path}`);
      parts.push(`FUNCTION: ${target.functionName}`);
      parts.push("```ts");
      parts.push(
        isDefaultExport
          ? `export default function (...) { /* corrected body, signature line included */ }`
          : `export function ${target.functionName}(...) { /* corrected body, signature line included */ }`,
      );
      parts.push("```");
    } else {
      parts.push(
        `Emit the COMPLETE file \`${target.path}\` in a FILE: block — every line, including unchanged ones. The full current contents are in Relevant Context below; copy the unchanged parts exactly.`,
      );
    }
  }

  parts.push(`\n## Turn ${turnNumber}`);

  // Answer-now recovery: the previous turn ran out of generation budget while
  // thinking and emitted no answer. Suppress history (less to read = less to
  // re-think) and demand an immediate action with no reasoning.
  if (opts?.answerNow) {
    parts.push(
      "\n## ANSWER NOW — your previous turn ran out of space while thinking and produced NO answer. Do NOT think this time. Output the FILE: block or TOOL: call as the FIRST line of your response — no <think>, no preamble, no explanation. Keep any reasoning to a single short sentence at most.",
    );
  } else if (opts?.redraft) {
    // Redraft section: suppress recent history, emit strategy hint.
    parts.push(
      "\n## REDRAFT — previous approach is stuck. Ignore prior attempts; re-read the spec and try a DIFFERENT approach.",
    );
    if (opts.strategyHint) {
      parts.push(`Strategy hint: ${opts.strategyHint}`);
    }
  } else {
    // Include last 2 turns of history (suppressed on redraft — dead-end attempts add noise)
    const recentTurns = state.turns.slice(-2);
    // Escalation counter for the whole-file-vs-PATCH mismatch recovery (below):
    // counts how many of the recent turns already hit this exact failure mode, so
    // the SECOND consecutive occurrence gets sterner, more explicit wording
    // instead of repeating the same instruction the model just ignored.
    let wholeFileMismatchSeen = 0;
    if (recentTurns.length > 0) {
      parts.push("\n## Recent History");
      for (const turn of recentTurns) {
        parts.push(`### Turn ${turn.turn} — Goal: ${turn.goalId}`);

        // Revert warning: this turn's edit applied but broke previously-passing
        // tests, so the loop rolled the file(s) back to their pre-turn state. Lead
        // with it so the model knows its change is GONE and must not build on it.
        if (turn.reverted && turn.reverted.newFailures.length > 0) {
          parts.push(
            `⚠ Your edit was REVERTED — it broke tests that were passing before: ${turn.reverted.newFailures.join(", ")}. The file is back to its original state. Re-edit and change ONLY the target function/line; do NOT modify other functions or unrelated code.`,
          );
        }

        if (turn.applyResults.length > 0) {
          parts.push("**Edit results:**");
          for (let ri = 0; ri < turn.applyResults.length; ri++) {
            const result = turn.applyResults[ri]!;
            // The block the model actually emitted for this result (same index —
            // applyBatch pushes exactly one result per input block, in order).
            const emittedBlock = turn.editBlocks[ri];
            const icon = result.status === "applied" ? "✓" : "✗";
            const detail = result.error ? ` — ${result.error}` : "";
            parts.push(`  ${icon} ${result.filePath} (${result.status})${detail}`);

            if (result.status !== "applied" && result.error?.includes(TEST_FILE_EDIT_REJECTED)) {
              // Test-file edit was rejected by the anti-fake-green guard. The
              // generic "re-emit the file" recovery below would CONTRADICT the
              // rejection (and re-show the test content) — push the model to the
              // implementation instead, and skip all re-emit branches.
              parts.push(
                `  ✗ ${result.filePath} — test/spec files are the specification and cannot be edited. Make your fix in the IMPLEMENTATION file (e.g. under src/) so the existing tests pass; do NOT emit any edit to a test file.`,
              );
            } else if (result.status !== "applied") {
              parts.push(`  ✗ ${result.filePath} — edit did not apply.`);
              const matchingChunk = context.chunks.find((c) => c.filePath === result.filePath);
              // PATCH-mode recovery must NOT tell the model to re-emit the whole
              // file: on a large file (the only reason we PATCH) the whole-file
              // emission truncates and is rejected, so the failed-edit feedback
              // would itself force the failure loop. Keep the model on the PATCH
              // block for the single target function instead.
              const tgt = context.targetFile;

              // Whole-file-vs-PATCH mismatch (checked FIRST, ahead of srRetry/
              // patchRetry): the model was directed to PATCH one function but
              // instead answered with a whole-file-shaped block (search === "")
              // — usually an ABBREVIATED re-emit with `// ...` elision, which the
              // truncation guard correctly rejected. Re-showing the whole file and
              // saying "don't emit the whole file" (the old patchRetry message) is
              // exactly the prompt that produced this mistake in the first place —
              // a 3B/7B pattern-matches "file shown → emit file back". Force a
              // concrete, copy-pasteable SEARCH/REPLACE template instead, scoped to
              // ONLY the target function's current text (not the whole file) so
              // there is nothing left to echo wholesale.
              const wholeFileMismatch =
                tgt?.path === result.filePath &&
                tgt.format === "patch" &&
                tgt.functionName !== undefined &&
                (emittedBlock?.search === "" || (result.error?.includes(ELISION_DETECTED) ?? false));

              // SR-mode recovery: when the failed file was given the SEARCH/REPLACE
              // (minimal-diff) directive — same gate buildTurnPrompt's "## Edit
              // Target" uses (patch format + functionName + DIFF_EDIT + large fn) —
              // the not-applied feedback must keep the model on SR. Falling through
              // to "re-emit the complete file" would CONTRADICT the directive it was
              // given for a large file → whole-file emission → truncation → fail
              // loop. Detect SR-mode BEFORE the generic PATCH/whole-file branches.
              const srRetry =
                !wholeFileMismatch &&
                tgt?.path === result.filePath &&
                tgt.format === "patch" &&
                tgt.functionName !== undefined &&
                DIFF_EDIT &&
                (tgt.functionLineCount ?? 0) >= DIFF_MIN_FN_LINES;
              const patchRetry =
                !wholeFileMismatch &&
                !srRetry &&
                tgt?.format === "patch" &&
                tgt.functionName !== undefined &&
                tgt.path === result.filePath;
              if (wholeFileMismatch) {
                wholeFileMismatchSeen++;
                const escalate = wholeFileMismatchSeen >= 2;
                const fnBody = matchingChunk
                  ? extractFunctionSource(matchingChunk.content, tgt!.functionName!)
                  : null;
                parts.push(
                  escalate
                    ? `  You made this SAME mistake again: a whole-file/abbreviated re-emit was rejected. This is your FINAL chance — Do NOT re-emit the file. Do NOT use \`// ...\` or ANY placeholder for "unchanged" code. Emit ONLY a SEARCH/REPLACE block for the exact lines that change, in this shape:`
                    : `  Your last answer re-emitted the WHOLE FILE (likely with \`// ...\` elision) instead of a targeted edit, and was rejected. Do NOT re-emit the file. Do NOT use \`// ...\` or any placeholder. Emit ONLY a SEARCH/REPLACE block for the lines that change, in exactly this shape:`,
                );
                parts.push("  ```");
                parts.push(`  ${tgt!.path}`);
                parts.push("  <<<<<<< SEARCH");
                parts.push("  (the exact current line(s) containing the bug)");
                parts.push("  =======");
                parts.push("  (the corrected line(s))");
                parts.push("  >>>>>>> REPLACE");
                parts.push("  ```");
                if (fnBody !== null) {
                  parts.push(
                    `  The \`${tgt!.functionName}\` function currently reads exactly (copy SEARCH text byte-for-byte from here — do NOT copy the whole file):`,
                  );
                  parts.push("  ```");
                  parts.push(fnBody);
                  parts.push("  ```");
                } else if (matchingChunk) {
                  parts.push(`  The file currently contains:`);
                  parts.push("  ```");
                  parts.push(matchingChunk.content);
                  parts.push("  ```");
                }
              } else if (srRetry) {
                parts.push(
                  `  Re-emit a SEARCH/REPLACE block for \`${tgt!.functionName}\`. Copy the SEARCH text BYTE-FOR-BYTE (exact indentation, every character) from the file shown below — the previous SEARCH did not match. Change only the buggy line(s) in REPLACE.`,
                );
                if (matchingChunk) {
                  parts.push(`  The file currently contains:`);
                  parts.push("  ```");
                  parts.push(matchingChunk.content);
                  parts.push("  ```");
                }
              } else if (patchRetry) {
                parts.push(
                  `  Re-emit a PATCH block for ONLY the \`${tgt!.functionName}\` function — do NOT emit the whole file (it will be truncated and rejected). Change the minimal lines to fix the bug; copy every other line of the function unchanged.`,
                );
                if (matchingChunk) {
                  parts.push(`  The file currently contains:`);
                  parts.push("  ```");
                  parts.push(matchingChunk.content);
                  parts.push("  ```");
                }
              } else if (matchingChunk) {
                // Show current file content so the model can re-emit the full file.
                parts.push(`  The file currently contains:`);
                parts.push("  ```");
                parts.push(matchingChunk.content);
                parts.push("  ```");
                parts.push("  Re-emit the COMPLETE corrected file in a FILE: block.");
              }
            }
          }
        }

        if (turn.toolResults.length > 0) {
          parts.push("**Tool results:**");
          for (const tr of turn.toolResults) {
            const icon = tr.success ? "✓" : "✗";
            // Surface enough output that a failing test's expected/received diff is
            // visible — the model needs the concrete failure to self-correct.
            parts.push(`  ${icon} ${tr.name}: ${tr.output.slice(0, 600)}`);
          }
        }
      }
    }
  }

  // (The structured failure diagnostic is rendered near the TOP of the turn body
  // — see the "## FAILING TEST — fix exactly this" block above — so it precedes
  // BOTH the "## Edit Target" directive and Recent History, leading with the bare
  // Expected/Received mismatch as the localization anchor.)

  // Scratchpad
  if (state.scratchpad.trim().length > 0) {
    parts.push("\n## Scratchpad");
    parts.push(state.scratchpad);
  }

  // Relevant context
  if (context.chunks.length > 0) {
    parts.push("\n## Relevant Context");
    for (const chunk of context.chunks) {
      parts.push(`### ${chunk.filePath} (lines ${chunk.startLine}–${chunk.endLine})`);
      parts.push("```");
      parts.push(chunk.content);
      parts.push("```");
    }
  }

  return parts.join("\n");
}

export interface FittedTurnPrompt {
  /** The assembled user-message prompt, guaranteed to fit (best-effort) under hardCap. */
  turnPrompt: string;
  /** Estimated tokens of system + turnPrompt for the returned prompt. */
  estimatedTokens: number;
  /** Number of repo-context chunks dropped to make it fit. */
  droppedChunks: number;
}

/**
 * Build a turn prompt that fits the model's window. Even with a correct repo
 * context budget, a single turn can overflow: the failed-edit path re-dumps a
 * full file into Recent History on top of ## Relevant Context, and token
 * estimation is approximate. This guard re-builds the prompt while dropping the
 * largest repo-context chunk each pass until `estimateTokens(system) +
 * estimateTokens(turnPrompt) <= hardCap`, or no chunks remain.
 *
 * History (the failing-test output and the failed-edit file the model needs to
 * self-correct) is never trimmed — only surplus ## Relevant Context chunks are
 * dropped, since the most task-relevant chunk is preserved longest (largest are
 * shed first). Pure: no I/O, deterministic for a given input.
 */
export function fitTurnPromptToWindow(
  state: AgentState,
  context: ContextBundle,
  systemPrompt: string,
  hardCap: number,
  opts?: BuildTurnPromptOpts,
): FittedTurnPrompt {
  const systemTokens = estimateTokens(systemPrompt);
  const chunks = [...context.chunks];
  let droppedChunks = 0;

  while (true) {
    const turnPrompt = buildTurnPrompt(state, { ...context, chunks }, opts);
    const estimatedTokens = systemTokens + estimateTokens(turnPrompt);

    if (estimatedTokens <= hardCap || chunks.length === 0) {
      return { turnPrompt, estimatedTokens, droppedChunks };
    }

    // Drop the largest remaining NON-pinned chunk and retry. Largest-first sheds
    // the most tokens per pass. Pinned chunks (the target file the model is being
    // asked to edit) are never shed — dropping them would leave the model editing
    // a file it cannot see, the exact failure this guard otherwise causes.
    let largestIdx = -1;
    let largestTokens = -1;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i]?.pinned) continue;
      const t = chunks[i]?.estimatedTokens ?? 0;
      if (t > largestTokens) {
        largestTokens = t;
        largestIdx = i;
      }
    }
    // Only pinned chunks remain — nothing left to shed. Return as-is (the pinned
    // target may exceed hardCap; the provider call surfaces that honestly rather
    // than us silently dropping the one file that matters).
    if (largestIdx === -1) {
      return { turnPrompt, estimatedTokens, droppedChunks };
    }
    chunks.splice(largestIdx, 1);
    droppedChunks++;
  }
}
