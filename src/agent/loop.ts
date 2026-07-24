import { readFile, rm, writeFile } from "node:fs/promises";
import path, { sep } from "node:path";
import { env } from "@/config/env.ts";
import type { ContextBundle } from "@/context/types.ts";
import { applyBatch, isOnTargetPath, isTestFilePath, parse } from "@/edit/index.ts";
import { promptHardCap } from "@/models/context-budget.ts";
import type { ModelProfile } from "@/models/types.ts";
import type { Provider } from "@/provider/types.ts";
import type { ReasoningHandler } from "@/reasoning/index.ts";
import {
  type RepairArchetype,
  type RepairCandidate,
  runArchetypeRepair,
} from "@/repair/archetype.ts";
import { enumerateLiteralMutations } from "@/repair/literal-mutation.ts";
import { enumerateComparisonMutations, scopeMutationsToRange } from "@/repair/operator-mutation.ts";
import { detectReadAfterDelete, repairReadAfterDelete } from "@/repair/read-after-delete.ts";
import { failureSignature } from "@/verify/failure-extract.ts";
import { checkNewImports, formatImportRejection } from "@/verify/import-check.ts";
import {
  captureTestBaseline,
  escalateBrokenClean,
  finalStateWorseThanBaseline,
  runTieredOracle,
  type TestBaseline,
} from "@/verify/oracle.ts";
import { advanceCarousel } from "./carousel.ts";
import { beginRun, markClean, recordOriginals, recoverIfNeeded } from "./journal.ts";
import { derivePhase, EXPLORE_REJECT_MESSAGE } from "./phase-gate.ts";
import { planTask } from "./planner.ts";
import { computeEditableSet, pinNeighborsIntoContext } from "./target-set.ts";
import { buildSystemPrompt, fitTurnPromptToWindow } from "./prompt.ts";
import { addTurn, advanceGoal, currentGoal, isTerminal, saveState } from "./state.ts";
import { rotateStrategy } from "./strategy.ts";
import { executeTool, type ToolContext } from "./tools.ts";
import type { AgentConfig, AgentState, ToolCall, ToolName, TurnRecord } from "./types.ts";

const STALL_LIMIT = 2;
const MAX_REDRAFTS = 2;

// Target-lock retarget (mis-pin self-correction, dogfood follow-up): how many
// CONSECUTIVE rejected attempts on the SAME off-target source file it takes
// before the lock gives up and retargets to that file. 2 was chosen so a
// mis-pinned retrieval self-corrects within one extra turn instead of
// dead-locking every remaining turn to max_turns, while still requiring more
// than a single accidental off-target edit (random drift touches a
// DIFFERENT file each turn and never reaches this streak).
const OFF_TARGET_RETARGET_THRESHOLD = 2;

/**
 * Target-lock retarget guard: decides whether an edit attempt at `attemptedPath`
 * (while `currentTarget` is the currently-enforced lock) should keep being
 * rejected, or whether the lock should GIVE UP on `currentTarget` and retarget
 * to `attemptedPath` instead. Mutates `state.offTargetStreak` (and, on
 * retarget, `state.lockedTargetPath`) and returns the path that should be
 * enforced for THIS attempt (unchanged, or the new retargeted path).
 *
 * On-target attempts and test-file attempts always reset the streak and never
 * retarget — the anti-fake-green guard (tests are the oracle) must never be
 * weakened by this. Only a persistent streak of attempts at the same
 * non-test, non-target SOURCE file can move the lock — a different
 * off-target file each turn (genuine drift) keeps resetting the streak to 1
 * and is rejected forever, same as before this fix.
 */
function trackOffTargetAttempt(
  state: AgentState,
  attemptedPath: string,
  currentTarget: string,
): string {
  if (isOnTargetPath(attemptedPath, currentTarget)) {
    state.offTargetStreak = undefined;
    return currentTarget;
  }
  if (isTestFilePath(attemptedPath)) {
    // Tests are never a retarget candidate — leave any in-progress streak on a
    // different (source) path untouched, but this attempt itself doesn't build
    // toward a retarget.
    return currentTarget;
  }
  const prior = state.offTargetStreak;
  const count =
    prior !== undefined && isOnTargetPath(prior.path, attemptedPath) ? prior.count + 1 : 1;
  if (count >= OFF_TARGET_RETARGET_THRESHOLD) {
    process.stderr.write(
      `[smallcode] retargeting lock: model persistently edits \`${attemptedPath}\` ≠ pinned \`${currentTarget}\` — retrieval likely mis-pinned; retargeting lock to \`${attemptedPath}\`\n`,
    );
    state.lockedTargetPath = attemptedPath;
    state.offTargetStreak = undefined;
    return attemptedPath;
  }
  state.offTargetStreak = { path: attemptedPath, count };
  return currentTarget;
}

// R2 externalize-localization (A/B-gated). When a failure's stack trace reached a
// source line (a runtime throw), surface a tight window around that exact line in
// the next prompt — the `where` a small model can't localize itself. Off by
// default → byte-identical to the prior loop, so the A/B baseline arm is clean.
const LOCALIZE = env.localize;

/**
 * Read a tight window around a 1-based source line, marking the failing line.
 * Returns null on any read error or an out-of-range line. Pure-ish (one read).
 */
async function readFailureWindow(
  absFile: string,
  line: number,
  repoRoot: string,
  radius = 6,
): Promise<{ file: string; line: number; window: string } | null> {
  try {
    const text = await Bun.file(absFile).text();
    const lines = text.split("\n");
    if (line < 1 || line > lines.length) return null;
    const lo = Math.max(1, line - radius);
    const hi = Math.min(lines.length, line + radius);
    const rel = path.relative(repoRoot, absFile);
    const body = [];
    for (let n = lo; n <= hi; n++) {
      const marker = n === line ? "  ⟵ FAILED HERE" : "";
      body.push(`${n}: ${lines[n - 1]}${marker}`);
    }
    return { file: rel, line, window: body.join("\n") };
  } catch {
    return null;
  }
}

export interface LoopDependencies {
  provider: Provider;
  profile: ModelProfile;
  reasoningHandler: ReasoningHandler;
  config: AgentConfig;
  /**
   * Optional per-run sampling override. Best-of-N uses this to vary temperature
   * across attempts so independent retries explore different solutions instead
   * of re-drawing the same one. Falls back to the model profile defaults.
   */
  samplingOverride?: { temperature?: number; top_p?: number };
  /**
   * Diff-review-before-write hook. When set (interactive runs with
   * sandbox.requireApproval), it is called with the proposed edit blocks BEFORE
   * they are written to disk; returning false skips applying them this turn. The
   * eval/non-interactive paths leave it unset → edits apply unconditionally, so
   * automated runs are unchanged.
   */
  approveEdit?: (blocks: import("@/edit/types.ts").EditBlock[]) => Promise<boolean>;
  /**
   * Test-only seam: override the final-state guard. Defaults to the real
   * `runFinalStateGuard`. Lets a test force the terminal guard to throw and
   * assert the fail-closed wrapper rolls the run back (E1-T4). Per-call, so it
   * never leaks across runs. Production leaves it unset.
   */
  finalStateGuardFn?: typeof runFinalStateGuard;
}

interface ParsedToolCall {
  name: ToolName;
  args: Record<string, unknown>;
  success: boolean;
  error?: string;
}

const KNOWN_TOOL_NAMES = new Set<ToolName>([
  "read_file",
  "write_file",
  "run_command",
  "run_tests",
  "finish",
  "think",
]);

function isToolName(name: string): name is ToolName {
  return KNOWN_TOOL_NAMES.has(name as ToolName);
}

function parseToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  // Match TOOL: <name> <json> on a single line
  const toolLineRe = /^TOOL:\s+(\S+)\s+(\{.*\}|\[\])\s*$/gm;
  // Also match TOOL: <name> {} with empty braces potentially
  const toolNoArgsRe = /^TOOL:\s+(\S+)\s*$/gm;

  const seenOffsets = new Set<number>();

  for (const match of text.matchAll(toolLineRe)) {
    const offset = match.index ?? 0;
    seenOffsets.add(offset);
    const rawName = match[1] ?? "";
    const rawArgs = match[2] ?? "{}";

    if (!isToolName(rawName)) {
      results.push({
        name: "think",
        args: {},
        success: false,
        error: `Unknown tool name: ${rawName}`,
      });
      continue;
    }

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        args = {};
      }
    } catch (err) {
      results.push({
        name: rawName,
        args: {},
        success: false,
        error: `Malformed JSON args: ${String(err)}`,
      });
      continue;
    }

    results.push({ name: rawName, args, success: true });
  }

  // Also capture bare tool calls without JSON args (e.g., TOOL: run_tests)
  for (const match of text.matchAll(toolNoArgsRe)) {
    const offset = match.index ?? 0;
    if (seenOffsets.has(offset)) continue;
    const rawName = match[1] ?? "";
    if (!isToolName(rawName)) continue;
    results.push({ name: rawName, args: {}, success: true });
  }

  return results;
}

function safeResolve(repoRoot: string, p: string): string | null {
  const base = path.resolve(repoRoot) + sep;
  const abs = path.resolve(repoRoot, p);
  if (!(abs + sep).startsWith(base)) return null;
  return abs;
}

function buildReadFile(repoRoot: string): (p: string) => Promise<string | null> {
  return async (p: string): Promise<string | null> => {
    const abs = safeResolve(repoRoot, p);
    if (abs === null) return null;
    try {
      return await readFile(abs, "utf-8");
    } catch {
      return null;
    }
  };
}

function buildWriteFile(repoRoot: string): (p: string, content: string) => Promise<void> {
  return async (p: string, content: string): Promise<void> => {
    const abs = safeResolve(repoRoot, p);
    if (abs === null) throw new Error(`Path traversal rejected: ${p}`);
    await writeFile(abs, content, "utf-8");
  };
}

/**
 * Restore each captured original file content via `writeFileFn`. Used to roll an
 * applied edit back to its pre-turn state when the edit regressed previously-green
 * tests, so the next turn doesn't iterate on a corrupted baseline. Pure-ish (no
 * loop state, no oracle) so it can be unit-tested against a fake write function.
 * `originals` maps the SAME path string that was passed to the read/write path
 * (relative to repoRoot) to its captured content. Only files that existed before
 * the edit are captured, so every entry is a plain content restore.
 */
export interface RevertResult {
  /**
   * True only when a `readFileFn` was supplied AND every restored file was read
   * back and its on-disk bytes matched the captured original. Fail-closed: when
   * no `readFileFn` is given (verification not requested) this is `false` — an
   * unverified restore is never reported as verified.
   */
  verified: boolean;
  /** Paths whose on-disk bytes did NOT match the intended original after write. */
  mismatched: string[];
}

export async function revertFiles(
  originals: Map<string, string>,
  writeFileFn: (p: string, content: string) => Promise<void>,
  // Optional read-back so the restore can be PROVEN, not assumed from the
  // absence of a write throw. A partial/failed write leaves stale bytes on disk;
  // without this check the guard concludes "restored" and reports safety it
  // cannot back up. When supplied, every file is re-read and byte-compared.
  readFileFn?: (p: string) => Promise<string | null>,
): Promise<RevertResult> {
  const mismatched: string[] = [];
  for (const [filePath, content] of originals) {
    await writeFileFn(filePath, content);
    if (readFileFn) {
      const readBack = await readFileFn(filePath);
      if (readBack !== content) mismatched.push(filePath);
    }
  }
  return { verified: readFileFn !== undefined && mismatched.length === 0, mismatched };
}

/**
 * Recover the PRISTINE (pre-model) content of the target file from turn history.
 * The revert system stamps `originalContent` on the FIRST applyResult that modified
 * each file (its content before that first edit), so the earliest turn that applied
 * an edit to `targetPath` holds the file exactly as the model FOUND it. Returns null
 * when the model never applied an edit to the target — in which case the on-disk
 * file is itself still pristine. Honors `effectivePath` (a path-typo rescue may have
 * redirected the write). Pure; exported for testing.
 */
export function pristineTargetContent(state: AgentState, targetPath: string): string | null {
  for (const turn of state.turns) {
    for (const r of turn.applyResults) {
      if (r.status !== "applied") continue;
      if ((r.effectivePath ?? r.filePath) !== targetPath) continue;
      if (r.originalContent !== undefined) return r.originalContent;
    }
  }
  return null;
}

/**
 * Run-level pristine snapshot for the final-state guard. Walks turn history and,
 * for every file the agent ever applied an edit to, recovers the content it had
 * BEFORE the agent's first edit (the earliest applyResult's `originalContent`)
 * — the whole-run generalization of {@link pristineTargetContent}. Files whose
 * first applied edit had no `originalContent` are brand-NEW (the agent created
 * them), returned separately so the guard can DELETE rather than restore them.
 * Restoring `originals` + deleting `created` returns the working tree to exactly
 * the state the agent found it in. Pure; exported for testing.
 */
export function pristineRunSnapshot(state: AgentState): {
  originals: Map<string, string>;
  created: string[];
} {
  const originals = new Map<string, string>();
  const created = new Set<string>();
  const seen = new Set<string>();
  for (const turn of state.turns) {
    for (const r of turn.applyResults) {
      if (r.status !== "applied") continue;
      const key = r.effectivePath ?? r.filePath;
      if (seen.has(key)) continue; // first edit per path wins — it holds the pristine state
      seen.add(key);
      if (r.originalContent !== undefined) originals.set(key, r.originalContent);
      else created.add(key); // brand-new file: no pre-edit content existed
    }
  }
  return { originals, created: [...created] };
}

/**
 * Recover the model's MOST-RECENT applied content for the target from turn history
 * (the `newContent` of the last turn that edited `targetPath`), even if that edit
 * was subsequently REVERTED off disk for regressing green tests. This is the mirror
 * of pristineTargetContent: a structural bug the model writes (e.g. the read-after-
 * delete ordering mistake) that stores a wrong value regresses previously-green
 * tests, so the loop reverts it — leaving disk pristine while the model's actual
 * structural attempt survives ONLY here. Both the RAD hint and statement-repair
 * must inspect this content, not disk, or they never see the pattern. Returns null
 * when the model never applied an edit to the target. Pure; exported for testing.
 */
export function latestAttemptContent(state: AgentState, targetPath: string): string | null {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const results = state.turns[i]?.applyResults ?? [];
    for (let j = results.length - 1; j >= 0; j--) {
      const r = results[j]!;
      if (r.status !== "applied") continue;
      if ((r.effectivePath ?? r.filePath) !== targetPath) continue;
      if (r.newContent !== undefined) return r.newContent;
    }
  }
  return null;
}

/**
 * Operator-mutation archetype: brute-force every single comparison/logical/
 * arithmetic operator flip in the locked target's function, PRISTINE base first
 * (the model often mangles the target on the way down — e.g. a `||` idiom into
 * `&&`/ternary — so a flip only reaches green against the original), then current.
 * Deterministic, can't fake-green (full-green oracle required). Single-file scope
 * even under SMALLCODE_TARGET_SET (repair stays on the primary — see
 * project_multifile_target_set).
 */
const operatorArchetype: RepairArchetype = {
  logName: "mutation-repair",
  targets: (state) => (state.lockedTargetPath !== undefined ? [state.lockedTargetPath] : []),
  candidatesFor(state, targetRel, current) {
    const cap = env.mutationRepairMax;
    const pristine = pristineTargetContent(state, targetRel);
    const bases: Array<{ text: string; base: string }> = [];
    if (pristine !== null && pristine !== current) bases.push({ text: pristine, base: "original" });
    bases.push({ text: current, base: "current" });

    // Priority-ordered, deduped across both bases, capped in TOTAL.
    const seen = new Set<string>([current]);
    const raw: Array<{ candidate: string; label: string; line: number; base: string }> = [];
    let totalAcross = 0;
    for (const { text, base } of bases) {
      const { mutations, totalFound } = enumerateComparisonMutations(text, cap);
      totalAcross += totalFound;
      for (const m of mutations) {
        if (raw.length >= cap) break;
        if (seen.has(m.candidate)) continue;
        seen.add(m.candidate);
        raw.push({ candidate: m.candidate, label: m.label, line: m.line, base });
      }
    }
    // Scope to the locked function: an out-of-function flip that greens a weakly-
    // covered test is not a real fix. Unknown range → whole-file fallback.
    const scoped = scopeMutationsToRange(raw, state.lockedTargetRange);
    if (state.lockedTargetRange !== undefined && scoped.length < raw.length) {
      console.error(
        `[mutation-repair] ${targetRel}: scoped to target fn L${state.lockedTargetRange.startLine}-${state.lockedTargetRange.endLine}, ${raw.length - scoped.length} out-of-function flip(s) skipped.`,
      );
    }
    if (scoped.length === 0) return [];
    if (totalAcross > scoped.length) {
      console.error(
        `[mutation-repair] ${targetRel}: ${totalAcross} operator candidate(s) across pristine+current, trying ${scoped.length} (cap ${cap}). Some flips not tried.`,
      );
    }
    return scoped.map((c) => ({ candidate: c.candidate, label: `${c.label} (${c.base})`, line: c.line }));
  },
};

/**
 * Harness-side operator-mutation repair (I/O). Thin wrapper over the shared
 * archetype driver; signature preserved for callers/tests. Returns the winning
 * flip's attribution or null.
 */
export async function runOperatorMutationRepair(
  state: AgentState,
  testBaseline: TestBaseline,
  readFileFn: (p: string) => Promise<string | null>,
  writeFileFn: (p: string, content: string) => Promise<void>,
  runOracle: typeof runTieredOracle = runTieredOracle,
): Promise<{ label: string; line: number; attempts: number } | null> {
  const r = await runArchetypeRepair(operatorArchetype, state, testBaseline, readFileFn, writeFileFn, runOracle);
  return r === null ? null : { label: r.label, line: r.line, attempts: r.attempts };
}

/**
/**
 * Literal-mutation archetype: brute-force small integer-literal perturbations
 * (±1/±2) for a wrong-CONSTANT bug no operator flip can reach (e.g. `toFixed(1)`
 * should be `toFixed(2)`). Unlike operator repair it iterates the MULTI-FILE
 * editable set (SMALLCODE_TARGET_SET) sharing ONE total cap across files (bounding
 * oracle cost regardless of set size), scoping to the function range only on the
 * primary target. Deterministic, can't fake-green (full-green oracle required).
 */
const literalArchetype: RepairArchetype = {
  logName: "literal-repair",
  targets: (state) =>
    state.editablePaths && state.editablePaths.length > 0
      ? state.editablePaths
      : state.lockedTargetPath !== undefined
        ? [state.lockedTargetPath]
        : [],
  candidatesFor(state, targetRel, current, attemptsSoFar) {
    const remaining = env.literalRepairMax - attemptsSoFar;
    if (remaining <= 0) return [];

    const pristine = pristineTargetContent(state, targetRel);
    const bases: Array<{ text: string; base: string }> = [];
    if (pristine !== null && pristine !== current) bases.push({ text: pristine, base: "original" });
    bases.push({ text: current, base: "current" });

    const seen = new Set<string>([current]);
    const raw: Array<{ candidate: string; label: string; line: number; base: string }> = [];
    let totalAcross = 0;
    for (const { text, base } of bases) {
      const { mutations, totalFound } = enumerateLiteralMutations(text, remaining);
      totalAcross += totalFound;
      for (const m of mutations) {
        if (raw.length >= remaining) break;
        if (seen.has(m.candidate)) continue;
        seen.add(m.candidate);
        raw.push({ candidate: m.candidate, label: m.label, line: m.line, base });
      }
    }

    // Scope to the locked function ONLY on the primary target; neighbor files in
    // the set have no range annotation (whole-file, bounded by the shared cap).
    const scoped =
      targetRel === state.lockedTargetPath ? scopeMutationsToRange(raw, state.lockedTargetRange) : raw;
    if (
      targetRel === state.lockedTargetPath &&
      state.lockedTargetRange !== undefined &&
      scoped.length < raw.length
    ) {
      console.error(
        `[literal-repair] ${targetRel}: scoped to target fn L${state.lockedTargetRange.startLine}-${state.lockedTargetRange.endLine}, ${raw.length - scoped.length} out-of-function literal(s) skipped.`,
      );
    }
    if (scoped.length === 0) return [];
    if (totalAcross > scoped.length) {
      console.error(
        `[literal-repair] ${targetRel}: ${totalAcross} literal candidate(s) across pristine+current, trying ${scoped.length} (remaining cap ${remaining}). Some flips not tried.`,
      );
    }
    return scoped.map((c) => ({ candidate: c.candidate, label: `${c.label} (${c.base})`, line: c.line }));
  },
};

/** Harness-side literal-mutation repair (I/O). Thin wrapper over the shared driver. */
export async function runLiteralRepair(
  state: AgentState,
  testBaseline: TestBaseline,
  readFileFn: (p: string) => Promise<string | null>,
  writeFileFn: (p: string, content: string) => Promise<void>,
  runOracle: typeof runTieredOracle = runTieredOracle,
): Promise<{ file: string; label: string; line: number; attempts: number } | null> {
  return runArchetypeRepair(literalArchetype, state, testBaseline, readFileFn, writeFileFn, runOracle);
}

/**
 * Statement-repair archetype (read-after-delete): a DISJOINT bug shape from the
 * operator/literal sweeps — the `X.delete(K); X.set(K, X.get(K))` ordering bug a
 * sub-14B model localizes yet writes reading AFTER the delete. Not a sweep: one
 * deterministic hoist per base. Because the model's buggy edit regresses green
 * tests and is reverted off disk, the model's LATEST attempt (from turn history)
 * is tried FIRST, then current disk — the analog of operator's pristine-first.
 */
const statementArchetype: RepairArchetype = {
  logName: "statement-repair",
  targets: (state) => (state.lockedTargetPath !== undefined ? [state.lockedTargetPath] : []),
  candidatesFor(state, targetRel, current) {
    const attempt = latestAttemptContent(state, targetRel);
    const bases: string[] = [];
    if (attempt !== null && attempt !== current) bases.push(attempt);
    bases.push(current);
    const candidates: RepairCandidate[] = [];
    for (const base of bases) {
      const rep = repairReadAfterDelete(base);
      if (rep === null) continue;
      candidates.push({ candidate: rep.candidate, label: rep.label, line: rep.line });
    }
    return candidates;
  },
};

/** Harness-side statement-repair (I/O). Thin wrapper over the shared driver. */
export async function runStatementRepair(
  state: AgentState,
  testBaseline: TestBaseline,
  readFileFn: (p: string) => Promise<string | null>,
  writeFileFn: (p: string, content: string) => Promise<void>,
  runOracle: typeof runTieredOracle = runTieredOracle,
): Promise<{ label: string; line: number; attempts: number } | null> {
  const r = await runArchetypeRepair(statementArchetype, state, testBaseline, readFileFn, writeFileFn, runOracle);
  return r === null ? null : { label: r.label, line: r.line, attempts: r.attempts };
}

/**
 * Final-state regression guard (SMALLCODE_FINAL_STATE_GUARD). Runs LAST, after the
 * model loop and every repair pass, only when the run ended UNSOLVED. Recaptures
 * the full test baseline on the FINAL disk state and, if the repo is strictly
 * WORSE than the run-start baseline, reverts every file the agent touched to its
 * pristine pre-model content and deletes any brand-new files it created — the
 * "never leave the repo worse than found" guarantee that dogfooding exposed as
 * missing (a wandering/partial run could exit with more red than it started).
 *
 * Eval-neutral by construction: it fires only on unsolved runs and restores the
 * seeded-bug START state, so an unsolved trial stays unsolved (pass/fail
 * unchanged) — it removes broken residue, it never manufactures a pass. After
 * reverting it recaptures once to CONFIRM the restore reached ≤ baseline and logs
 * the honest before/after. Records `state.finalStateReverted` on a real revert.
 * Returns true iff it reverted. Deterministic; model-agnostic.
 */
export async function runFinalStateGuard(
  state: AgentState,
  testBaseline: TestBaseline,
  writeFileFn: (p: string, content: string) => Promise<void>,
  // Read-back used to PROVE the restore landed. Defaults to a real disk read of
  // `state.repoRoot`; injectable so tests can simulate a partial/failed write.
  readFileFn: (p: string) => Promise<string | null> = buildReadFile(state.repoRoot),
): Promise<boolean> {
  // No test signal at baseline → nothing to compare a "worse" against.
  if (!testBaseline.hadAnyTests) return false;

  const finalState = captureTestBaseline(state.repoRoot);
  const { worse, newFailures } = finalStateWorseThanBaseline(testBaseline, finalState);
  if (!worse) return false;

  const { originals, created } = pristineRunSnapshot(state);
  if (originals.size === 0 && created.length === 0) return false; // agent changed nothing on disk

  // Verified restore: write each pristine file back, then re-read and byte-check.
  const revertRes = await revertFiles(originals, writeFileFn, readFileFn);
  // Created files must end up GONE; confirm each deletion (fail-closed).
  const createdNotDeleted: string[] = [];
  for (const rel of created) {
    const abs = safeResolve(state.repoRoot, rel);
    if (abs !== null) await rm(abs, { force: true });
    if ((await readFileFn(rel)) !== null) createdNotDeleted.push(rel);
  }

  const restoreVerified = revertRes.verified && createdNotDeleted.length === 0;
  const restored = captureTestBaseline(state.repoRoot);
  console.error(
    `[final-state-guard] reverted ${originals.size + created.length} file(s): run ended UNSOLVED and worse than baseline ` +
      `(red ${testBaseline.redCount}→${finalState.redCount}${newFailures.length ? `, new failures: ${newFailures.join(", ")}` : ""}). ` +
      `Restored to pristine (red now ${restored.redCount}).`,
  );
  if (!restoreVerified) {
    const bad = [...revertRes.mismatched, ...createdNotDeleted].join(", ");
    console.error(
      `[final-state-guard] UNSAFE: could not verify the restore of ${bad} — the working tree may be ` +
        `inconsistent. Recover before trusting it: 'git checkout -- .' (or restore from the write-ahead ` +
        `journal). The "never leave the repo worse" guarantee is UNVERIFIED for this run.`,
    );
  }

  state.finalStateReverted = {
    newFailures,
    startRed: testBaseline.redCount,
    endRed: finalState.redCount,
    filesRestored: originals.size + created.length,
    restoreVerified,
  };
  return true;
}

export async function runLoop(
  state: AgentState,
  statePath: string,
  deps: LoopDependencies,
  getContext: (goal: string) => Promise<ContextBundle>,
): Promise<AgentState> {
  const { provider, profile, reasoningHandler, config } = deps;
  const sampleTemp = deps.samplingOverride?.temperature ?? profile.samplingDefaults.temperature;
  const sampleTopP = deps.samplingOverride?.top_p ?? profile.samplingDefaults.top_p;
  const systemPrompt = buildSystemPrompt(profile, config);
  // Ceiling for system + user prompt; repo context is trimmed to fit so the
  // request never overflows the model window (HTTP 400) or starves generation.
  const hardCap = promptHardCap(profile);

  const readFileFn = buildReadFile(state.repoRoot);
  const writeFileFn = buildWriteFile(state.repoRoot);
  const rmFileFn = async (p: string): Promise<void> => {
    const abs = safeResolve(state.repoRoot, p);
    if (abs !== null) await rm(abs, { force: true });
  };

  // Write-ahead apply journal (crash recovery, SMALLCODE_APPLY_JOURNAL). BEFORE
  // any write this run makes: (1) replay a journal left by a PREVIOUS run that
  // was killed mid-apply on this repo — restoring the pre-crash state so the
  // baseline below is captured on a clean tree, not a half-written one; (2) open
  // a fresh in-progress journal for THIS run. A clean finish deletes it
  // (markClean, just before return); a crash leaves it for the next run.
  const journalOn = env.applyJournal;
  if (journalOn) {
    const rec = await recoverIfNeeded(state.repoRoot, writeFileFn, rmFileFn);
    if (rec.recovered) {
      console.error(
        `[smallcode] recovered an interrupted run — restored ${rec.restored.length} file(s) and removed ` +
          `${rec.deleted.length} created file(s) to your pre-run state.`,
      );
    }
    if (rec.failed.length > 0) {
      console.error(
        `[smallcode] UNSAFE: could not recover ${rec.failed.join(", ")} from the previous interrupted run — ` +
          `the working tree may be inconsistent. Recover with 'git checkout -- .' before trusting it.`,
      );
    }
    await beginRun(state.repoRoot, state.sessionId, new Date(state.startedAt).toISOString());
  }
  // Journaling write used ONLY for edit-apply (not reverts): records each file's
  // pre-run content the first time it is written, then writes. First-seen-wins in
  // the journal keeps the true pre-run bytes across multi-turn edits to one file.
  const journalWrite = journalOn
    ? async (p: string, content: string): Promise<void> => {
        await recordOriginals(state.repoRoot, [p], readFileFn);
        await writeFileFn(p, content);
      }
    : writeFileFn;

  // Tool execution context. Model-emitted tool calls (run_tests, run_command,
  // read_file) were previously parsed but never executed — the agent flew blind,
  // calling `finish` without ever verifying. We now execute them and, critically,
  // run the test suite at the end of each turn as a deterministic pass-oracle.
  const toolCtx: ToolContext = {
    repoRoot: state.repoRoot,
    allowedCommands: config.allowedCommands ?? ["bun", "tsc", "biome", "git"],
    requireApproval: config.requireApproval ?? false,
  };

  // Planning phase: decompose the task into goals if none exist yet.
  if (state.goals.length === 0) {
    let context: ContextBundle;
    try {
      context = await getContext(state.task);
    } catch {
      context = { chunks: [], totalTokens: 0, tokenBudget: 0, truncated: false, query: state.task };
    }
    state.goals = await planTask(state.task, context, {
      provider,
      modelId: state.modelId,
      profile,
      repoRoot: state.repoRoot,
      preSolveReflection: config.preSolveReflection,
      plannerPrompt: config.promptSet?.planner,
      reflectionPrompt: config.promptSet?.reflection,
    });
    await saveState(state, statePath);
  }

  // Capture a pre-loop baseline of any already-failing tests so that
  // pre-existing unrelated failures don't prevent early-stop after the task
  // is solved.  On fresh single-file benchmark repos (no pre-existing failures)
  // the baseline set is empty and behaviour is identical to before this fix.
  const testBaseline = captureTestBaseline(state.repoRoot);

  // Target-lock fix-mode: true when the baseline already had a red test — the
  // drift-prone regime (bug-fix with a failing test) dogfooding surfaced. A
  // clean baseline (new-feature / no-test-yet task) never enforces the lock
  // even when a target happens to be pinned, since there's no "the fix goes
  // HERE" red signal to key off.
  const fixModeBaseline =
    testBaseline.hadAnyTests && (testBaseline.failingIds.size > 0 || testBaseline.redCount > 0);

  // Stall/redraft carry-forward: tracks whether the NEXT turn should be a redraft.
  let redraftNext = false;
  let redraftStrategyHint: string | undefined;
  // Think-only recovery carry-forward: set when a turn truncates mid-reasoning
  // (emits reasoning but no answer). The NEXT turn is drafted under the
  // ANSWER-NOW prompt so the model stops thinking and acts. Without this, the
  // identical prompt was retried and the model truncated the same way again.
  let answerNowNext = false;

  while (!isTerminal(state) && state.turns.length < state.maxTurns) {
    const goal = currentGoal(state);
    if (goal === null) {
      state.status = "done";
      break;
    }

    // Mark goal in_progress
    goal.status = "in_progress";

    let rawResponse = "";
    let reasoning: string | undefined;
    let answer = "";
    let promptTokens = 0;
    let completionTokens = 0;
    // Set when this turn truncates mid-reasoning; drives the answer-now recovery.
    let thinkOnly = false;

    let context: ContextBundle;
    try {
      context = await getContext(goal.description);
    } catch {
      context = {
        chunks: [],
        totalTokens: 0,
        tokenBudget: 0,
        truncated: false,
        query: goal.description,
      };
    }

    // P0#2 phase-gated tool access (opt-in, SMALLCODE_PHASE_GATE — default off,
    // see phase-gate.ts). `explorePhase` gates OUT of the same module the
    // prompt (prompt.ts) advertises INTO, so the two can never drift. When the
    // flag is off this is always false and every gate below is a no-op — byte-
    // identical to pre-feature behavior. A confidently-pinned target is always
    // "edit" phase (derivePhase), so a pinned-target run never hits this gate
    // even with the flag on — preserving the common 1-turn-solve path.
    const explorePhase = env.phaseGate && derivePhase(state, context) === "explore";

    // Target-lock: capture the FIRST confidently-pinned edit target ONCE and
    // enforce THAT stable value for the whole run — never the live per-turn
    // `context.targetFile`. `context` is rebuilt every turn via `getContext`,
    // so once the model edits an off-target file, that file enters recent-
    // history/context and retrieval re-pins `context.targetFile` onto it
    // (dogfood: the model edited an unrelated file 6x with ZERO rejections
    // because the lock kept "moving" to follow the drift). Locking to
    // `state.lockedTargetPath` — set once below and never overwritten — means
    // drift can no longer relocate the enforcement target.
    if (
      state.lockedTargetPath === undefined &&
      fixModeBaseline &&
      context.targetFile !== undefined
    ) {
      state.lockedTargetPath = context.targetFile.path;
      const tf = context.targetFile;
      if (tf.functionStartLine !== undefined && tf.functionEndLine !== undefined) {
        state.lockedTargetRange = { startLine: tf.functionStartLine, endLine: tf.functionEndLine };
      }
      // Multi-file target set (SMALLCODE_TARGET_SET): widen the lock from the
      // single primary to its bounded import neighborhood so a coupled fix can
      // reach the helper module. Computed ONCE alongside the primary pin.
      if (env.targetSet) {
        state.editablePaths = await computeEditableSet(context.targetFile.path, state.repoRoot);
      }
    }
    // `env.targetLock` is the escape hatch for a genuine multi-file task that
    // happens to also match fix-mode (SMALLCODE_TARGET_LOCK=0 disables
    // enforcement entirely). If no confident target was EVER established,
    // the lock stays off for the whole run (multi-file tasks unaffected).
    const lockTargetPath =
      env.targetLock && fixModeBaseline && state.lockedTargetPath !== undefined
        ? state.lockedTargetPath
        : undefined;
    // Mutable per-turn view of the enforced target: `trackOffTargetAttempt`
    // (mis-pin retarget guard, below) can move it mid-turn when a persistent
    // off-target streak crosses the threshold, so the SAME turn's remaining
    // write attempts (edit blocks, then write_file tool calls) enforce
    // against the NEW target rather than waiting for the next turn.
    let lockTargetPathForTurn = lockTargetPath;
    // When the multi-file set is active, enforcement checks membership in the
    // bounded neighborhood instead of the single primary; the mis-pin retarget
    // guard is skipped (the explicit set is authoritative, so there is no single
    // target to "give up" on). `useSet` gates that branch at both write paths.
    const useSet =
      lockTargetPath !== undefined &&
      env.targetSet &&
      state.editablePaths !== undefined &&
      state.editablePaths.length > 0;
    const lockAllowedPaths = useSet ? state.editablePaths : undefined;
    // Guarantee the model can actually SEE every file it is now allowed to edit:
    // force each neighbor's full contents into context as a pinned chunk. Without
    // this the prompt would name a helper module the model may never have in view.
    if (useSet && state.editablePaths !== undefined) {
      await pinNeighborsIntoContext(context.chunks, state.editablePaths, readFileFn);
    }

    // Build turn prompt. Answer-now recovery (think-only truncation last turn)
    // takes precedence over a stall redraft — getting ANY answer out beats trying
    // a different approach when the model never finished speaking.
    const turnAnswerNow = answerNowNext;
    const turnPromptOpts = turnAnswerNow
      ? { answerNow: true }
      : redraftNext
        ? { redraft: true, strategyHint: redraftStrategyHint }
        : undefined;
    const fitted = fitTurnPromptToWindow(state, context, systemPrompt, hardCap, turnPromptOpts);
    const turnPrompt = fitted.turnPrompt;
    if (fitted.droppedChunks > 0) {
      process.stderr.write(
        `[smallcode] trimmed ${fitted.droppedChunks} context chunk(s) to fit window (~${fitted.estimatedTokens}/${hardCap} tokens)\n`,
      );
    }
    // Consume the carry-forward flags (they apply to this turn only).
    redraftNext = false;
    redraftStrategyHint = undefined;
    answerNowNext = false;

    try {
      const response = await provider.complete({
        model: state.modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: turnPrompt },
        ],
        temperature: sampleTemp,
        top_p: sampleTopP,
        max_tokens: profile.samplingDefaults.max_tokens,
        ollamaOptions: profile.ollamaOptions,
      });

      rawResponse = response.rawContent;
      promptTokens = response.usage?.promptTokens ?? 0;
      completionTokens = response.usage?.completionTokens ?? 0;

      const parsed = reasoningHandler.parse(rawResponse);
      reasoning = parsed.reasoning ?? undefined;
      answer = parsed.answer;

      // Empty generation: the provider returned ZERO tokens — no reasoning, no answer,
      // empty raw content. This is a wedged/disconnected backend (a flapping local
      // Ollama returns {"response":"","done":false}), NOT a model failure. Tag it
      // distinctly ("infra: empty model generation") so the eval can exclude the trial
      // instead of forging a clean 0.00. Distinct from think-only, which HAS reasoning.
      if (rawResponse.trim() === "" && completionTokens === 0) {
        throw new Error(
          "infra: empty model generation (provider returned zero tokens — likely wedged/disconnected backend)",
        );
      }

      // Think-only truncation: reasoning present but answer empty → completion was cut short.
      // Treat as an error turn rather than silently scoring a non-answer, and flag
      // the next turn for answer-now recovery so we don't re-run the same prompt.
      if (parsed.hasReasoning && answer === "" && response.truncated !== false) {
        thinkOnly = true;
        throw new Error(
          "think-only completion: model emitted reasoning but no answer (likely truncated)",
        );
      }
    } catch (err) {
      // Record a failed turn but continue
      rawResponse = "";
      answer = "";
      reasoning = undefined;
      const errMsg = err instanceof Error ? err.message : String(err);

      const failedTurn: TurnRecord = {
        turn: state.turns.length + 1,
        goalId: goal.id,
        prompt: turnPrompt,
        rawResponse,
        reasoning,
        answer,
        toolCalls: [],
        toolResults: [{ name: "think", success: false, output: "", error: errMsg }],
        editBlocks: [],
        applyResults: [],
        promptTokens,
        completionTokens,
        timestamp: Date.now(),
        ...(turnAnswerNow && { answerNow: true }),
      };

      addTurn(state, failedTurn);

      // Think-only truncation → draft the NEXT turn under the answer-now prompt
      // (skip thinking, act immediately) instead of re-running the identical
      // prompt that just truncated. No-op if this was already the last turn.
      if (thinkOnly && state.turns.length < state.maxTurns) {
        answerNowNext = true;
      }
      await saveState(state, statePath);

      // Check maxTurns after adding the failed turn
      if (state.turns.length >= state.maxTurns) {
        state.status = "max_turns";
        await saveState(state, statePath); // FIX #5: persist max_turns so state.json never shows "running"
      }
      continue;
    }

    // Parse edit blocks from answer
    const parseResult = parse(answer);
    const editBlocks = parseResult.blocks;

    // Apply edits — diff-review gate first. When an approveEdit hook is present
    // (interactive run with requireApproval), the user sees the proposed edits and
    // can reject them; a rejected turn writes nothing and tells the model so.
    let applyResults: import("@/edit/types.ts").ApplyResult[] = [];
    let editRejected = false;
    // P0#2 phase gate: no confident target yet AND no file read this run — the
    // model must localize before it edits. Reject the whole batch, write
    // nothing, same as the diff-review-rejection path below.
    let phaseGateEditRejected = false;
    if (editBlocks.length > 0 && explorePhase) {
      phaseGateEditRejected = true;
    } else if (editBlocks.length > 0) {
      let approved = true;
      if (deps.approveEdit) {
        try {
          approved = await deps.approveEdit(editBlocks);
        } catch {
          approved = false;
        }
      }
      if (!approved) {
        editRejected = true;
      } else {
        // Mis-pin retarget guard: before enforcing, let each block's attempted
        // path push the streak — a persistent same-file off-target streak
        // retargets `lockTargetPathForTurn` (and `state.lockedTargetPath`) so
        // THIS batch's write is enforced against the corrected target instead
        // of being rejected forever. On-target/test-file blocks are no-ops.
        if (!useSet && lockTargetPathForTurn !== undefined) {
          for (const block of editBlocks) {
            lockTargetPathForTurn = trackOffTargetAttempt(
              state,
              block.filePath,
              lockTargetPathForTurn,
            );
          }
        }
        try {
          const batchResult = await applyBatch(
            editBlocks,
            readFileFn,
            journalWrite,
            useSet
              ? { targetPaths: lockAllowedPaths }
              : lockTargetPathForTurn !== undefined
                ? { targetPath: lockTargetPathForTurn }
                : undefined,
          );
          applyResults = batchResult.results;
        } catch {
          applyResults = [];
        }
      }
    }

    // Parse tool calls from answer
    const parsedToolCalls = parseToolCalls(answer);
    const toolCalls: ToolCall[] = parsedToolCalls
      .filter((tc) => tc.success)
      .map((tc) => ({ name: tc.name, args: tc.args }));

    // Build tool results: start with failed parses.
    const toolResults: TurnRecord["toolResults"] = parsedToolCalls
      .filter((tc) => !tc.success)
      .map((tc) => ({
        name: tc.name,
        success: false,
        output: "",
        error: tc.error,
      }));

    // Diff-review: a user-rejected edit applied nothing — tell the model so it can
    // revise (or stop) rather than assume its change landed.
    if (editRejected) {
      toolResults.push({
        name: "write_file",
        success: false,
        output: "",
        error:
          "The proposed edit was REJECTED by the user and NOT written. Revise the approach or stop.",
      });
    }

    // P0#2 phase gate: same rejection wording the "explore" turn prompt already
    // told the model to expect (phase-gate.ts EXPLORE_REJECT_MESSAGE).
    if (phaseGateEditRejected) {
      toolResults.push({
        name: "write_file",
        success: false,
        output: "",
        error: EXPLORE_REJECT_MESSAGE,
      });
    }

    // SMALLCODE_IMPORT_GATE (Lever 2, default off): reject HALLUCINATED imports
    // BEFORE the oracle. For each FILE:/PATCH: edit that landed on an existing
    // source file, resolve the specifiers the edit INTRODUCED against ground
    // truth (package.json deps + node_modules + the filesystem). Any that don't
    // resolve (the dogfood `std/strings` invention) revert that file to its
    // pre-edit content and feed the model a targeted "does not resolve; available
    // deps: …" message — a crisper, earlier signal than R4's post-test-run
    // "Cannot find module", which the model looped on. Only new imports on an
    // existing file are checked; brand-new files (no originalContent) and test
    // files are skipped.
    if (env.importGate && applyResults.length > 0) {
      for (const r of applyResults) {
        if (r.status !== "applied" || r.newContent === undefined || r.originalContent === undefined)
          continue;
        const rel = r.effectivePath ?? r.filePath;
        if (isTestFilePath(rel)) continue;
        const check = await checkNewImports(r.originalContent, r.newContent, rel, state.repoRoot);
        if (check.unresolved.length === 0) continue;
        // Ground the edit out: restore the pre-edit content so the next turn does
        // not build on a non-resolving import, and the oracle sees pristine.
        try {
          await writeFileFn(rel, r.originalContent);
        } catch {
          // Restore failure is non-fatal — leave the edit and let R4 catch it.
        }
        console.error(
          `[import-gate] reverted ${rel}: unresolved import(s) ${check.unresolved.join(", ")}.`,
        );
        toolResults.push({
          name: "write_file",
          success: false,
          output: "",
          error: formatImportRejection(rel, check),
        });
      }
    }

    // The `write_file` TOOL call writes straight to disk (tools.ts) and — unlike
    // FILE:/PATCH: edit blocks — is never routed through applyBatch, so its
    // pre-write content is never captured anywhere. A build-breaking write_file
    // therefore left revertOriginals (below) empty even when verdict.regressed
    // was true, so the revert-on-regression guarantee silently didn't apply to
    // it (the actual dogfood bug: a garbage write_file edit survived 5 turns).
    // Snapshot each target's pre-turn content here, BEFORE executing, the same
    // way applyBatch stashes the first on-disk version it sees per path — so a
    // regression can be rolled back regardless of which write path produced it.
    const toolWriteOriginals = new Map<string, string>();
    const toolWritePaths: string[] = [];
    for (const call of toolCalls) {
      if (call.name !== "write_file") continue;
      const p = call.args["path"];
      if (typeof p !== "string" || toolWriteOriginals.has(p)) continue;
      const disk = await readFileFn(p);
      if (disk !== null) toolWriteOriginals.set(p, disk); // null = new file, nothing to revert to
      if (!toolWritePaths.includes(p)) toolWritePaths.push(p);
    }
    // Journal the tool write_file targets (crash recovery) BEFORE they execute —
    // the write_file path bypasses applyBatch/journalWrite, so record here or a
    // kill mid-write leaves a new/overwritten file with no rollback. readFileFn
    // returns null for a not-yet-created file → journal marks it for deletion.
    if (journalOn && toolWritePaths.length > 0) {
      await recordOriginals(state.repoRoot, toolWritePaths, readFileFn);
    }

    // Execute model-emitted side-effecting tool calls (read_file, run_command,
    // run_tests) so their real output feeds back into the next turn. think/finish
    // are control-flow only and handled separately below.
    for (const call of toolCalls) {
      if (call.name === "think" || call.name === "finish") continue;

      // P0#2 phase gate: "explore" phase only advertises read_file/run_tests/
      // think/finish (PHASE_ALLOWED_TOOLS in phase-gate.ts) — write_file and
      // run_command are rejected outright, never executed, same wording the
      // turn prompt already gave the model.
      if (explorePhase && (call.name === "write_file" || call.name === "run_command")) {
        toolResults.push({
          name: call.name,
          success: false,
          output: "",
          error: EXPLORE_REJECT_MESSAGE,
        });
        continue;
      }

      // Target-lock (write_file path): mirrors the applyBatch reject above for
      // the OTHER write path — `TOOL: write_file` bypasses applyBatch entirely
      // and writes straight to disk in tools.ts, so it needs its own guard.
      // Skipped with feedback, never executed — no write, nothing to revert.
      // Same mis-pin retarget guard as the applyBatch path above: a persistent
      // same-file streak can move `lockTargetPathForTurn` (and the stable
      // `state.lockedTargetPath`) so this write_file is allowed through
      // instead of rejected forever.
      if (call.name === "write_file" && lockTargetPathForTurn !== undefined) {
        const p = call.args["path"];
        if (useSet) {
          // Multi-file set: allow the write iff it lands on any neighborhood member.
          if (typeof p === "string" && !lockAllowedPaths!.some((t) => isOnTargetPath(p, t))) {
            const allowList = lockAllowedPaths!.map((t) => `\`${t}\``).join(", ");
            toolResults.push({
              name: "write_file",
              success: false,
              output: "",
              error: `Edit REJECTED — this fix may only touch ${allowList}; your edit to \`${p}\` was NOT written. Make your change in one of those.`,
            });
            continue;
          }
        } else {
          if (typeof p === "string") {
            lockTargetPathForTurn = trackOffTargetAttempt(state, p, lockTargetPathForTurn);
          }
          if (typeof p === "string" && !isOnTargetPath(p, lockTargetPathForTurn)) {
            toolResults.push({
              name: "write_file",
              success: false,
              output: "",
              error: `Edit REJECTED — this task fixes only \`${lockTargetPathForTurn}\`; your edit to \`${p}\` was NOT written. Make your change in \`${lockTargetPathForTurn}\`.`,
            });
            continue;
          }
        }
      }

      try {
        toolResults.push(await executeTool(call, toolCtx));
      } catch (err) {
        toolResults.push({
          name: call.name,
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Tiered verification oracle (authoritative end-of-turn check). Tier 1 is the
    // test suite — green == solved (the trial/grader suite is the same one). When
    // NO test covers the change (real repos editing untested code), it falls back
    // to a typecheck so the agent still gets ground-truth feedback instead of
    // flying blind. Outcome drives early-stop below.
    let verdict: Awaited<ReturnType<typeof runTieredOracle>> | undefined;
    try {
      verdict = await runTieredOracle(state.repoRoot, { baseline: testBaseline });
      // Oracle-free safety: a no-test "clean" turn whose static confidence is
      // "broken" means THIS edit does not parse — accepting it would leave the
      // repo non-compiling even though no test flagged it. escalateBrokenClean
      // converts it to a failing+regressed verdict so the existing
      // revert-on-regression, BUILD ERROR prompt, and stall detection all fire —
      // exactly as R4 does for the test-backed load-error case, generalized to
      // untested repos. No-op when confidence is absent or not "broken".
      verdict = escalateBrokenClean(verdict);
      toolResults.push({
        name: "run_tests",
        success: verdict.outcome === "solved",
        output:
          verdict.outcome === "solved"
            ? "verified: tests pass"
            : verdict.outcome === "clean"
              ? "no failing checks (no test covers this change yet)"
              : verdict.feedback,
        error: verdict.outcome === "failing" ? verdict.feedback : undefined,
      });
    } catch {
      // Verification failure is non-fatal — continue the loop.
    }

    // Revert-on-REGRESSION: if an applied edit regressed the suite (flipped
    // previously-green tests red, OR crashed a module so more tests are red than
    // baseline with no parseable `(fail)` line), roll the edited files back to
    // their pre-turn content so the next turn doesn't build on a corrupted
    // baseline. Gate on `verdict.regressed` — NOT `newFailures.length` — so a
    // crash-regression (empty parseable failures) is reverted too.
    // CRITICAL: revert ONLY on a TRUE regression. A still-red suite with NO
    // regression (outcome "failing", regressed falsy — the model just hasn't
    // fixed the target yet) is NOT reverted: that would discard legitimate
    // progress. "solved" (fully green) is never a regression, so never reverts.
    //
    // Build the revert set from the APPLY RESULTS, not a pre-apply capture by
    // emitted block path: applyBatch's path-typo rescue can write to a different
    // effective path than the block named, and it reports the pre-batch original
    // per effective path. Reverting by effectivePath restores the file actually
    // corrupted; reverting by the emitted (typo) path would miss it.
    const revertOriginals = new Map<string, string>();
    for (const r of applyResults) {
      if (r.status !== "applied") continue;
      if (r.originalContent === undefined) continue; // brand-new file → leave in place
      const key = r.effectivePath ?? r.filePath;
      if (!revertOriginals.has(key)) revertOriginals.set(key, r.originalContent);
    }
    // Fold in write_file TOOL originals captured above so a build-breaking
    // write_file is reverted exactly like a build-breaking FILE:/PATCH: block.
    for (const [key, content] of toolWriteOriginals) {
      if (!revertOriginals.has(key)) revertOriginals.set(key, content);
    }
    let revertedNewFailures: string[] | undefined;
    let reverted = false;
    if (verdict?.regressed === true && revertOriginals.size > 0) {
      try {
        const res = await revertFiles(revertOriginals, writeFileFn, readFileFn);
        revertedNewFailures = [...(verdict.newFailures ?? [])];
        reverted = true;
        if (!res.verified) {
          console.error(
            `[per-turn-revert] UNSAFE: could not verify the restore of ${res.mismatched.join(", ")} — ` +
              `the working tree may be inconsistent for the next turn.`,
          );
        }
      } catch {
        // Restore failure is non-fatal: leave the edit in place and continue.
      }
    }

    // Set-carousel (SMALLCODE_SET_CAROUSEL, opt-in): computed BEFORE the stall/
    // redraft block below so the redraft trigger can yield to it (see the
    // `!carouselActive` guard a few lines down). When active AND the model
    // stalls, the carousel — not a same-file redraft — is the response: a
    // redrafted prompt on the SAME file is useless when the real remaining bug
    // is in a DIFFERENT file in the editable set. Firing on stall ALONE (not
    // gated on exhausting redrafts first) matters for bounded eval budgets — a
    // redraft-then-carousel sequence would burn ~2× STALL_LIMIT turns before
    // ever advancing focus. Attention-only: never touches lockedTargetPath,
    // lockAllowedPaths, applyBatch, revert, or the repair passes — every member
    // of editablePaths stays editable throughout, as it already is under
    // SMALLCODE_TARGET_SET.
    const carouselActive =
      env.setCarousel && useSet && state.editablePaths !== undefined && state.editablePaths.length > 1;

    // Stall detection: compute failure signature and check if we're stuck.
    //
    // Fix 3b: Gate stall on verdict.outcome === "failing" ALONE — do NOT require
    // verdict.diagnostic to be present. When diagnostic is available use it for
    // a stable signature; otherwise fall back to a stable hash of the feedback
    // text. This ensures typecheck-tier failures (where extractFirstFailure
    // previously returned null) also participate in stall detection.
    let turnFailureSig: string | undefined;
    let turnRedrafted = false;

    // Snapshot the prior failure signature BEFORE the stall block overwrites it.
    // Fix 3: on a reverted turn the disk is back to its PRE-turn state, so the
    // post-edit verdict signature does not describe the effective state. Using
    // the prior signature instead means consecutive regress→revert cycles are
    // seen as the SAME repeated failure, so the stall counter ADVANCES and the
    // existing redraft/answer-now brake eventually fires (instead of oscillating
    // to maxTurns).
    const priorFailureSig = state.lastFailureSignature;

    if (verdict?.outcome === "failing") {
      // Compute a stable signature: prefer the structured diagnostic; fall back
      // to the first 200 chars of feedback (already stable — no timing, no paths
      // in tsc/feedback text after normalization).
      if (verdict.diagnostic) {
        turnFailureSig = failureSignature(verdict.diagnostic);
      } else {
        // Stable fallback from feedback text — normalize timing/paths/whitespace.
        const fbStable = (verdict.feedback ?? "")
          .replace(/\[\d+(?:\.\d+)?ms\]/g, "")
          .replace(/\/[^\s'"]+\/([^/\s'"]+)/g, "<path>/$1")
          .replace(/:\d+:\d+/g, ":<loc>")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        turnFailureSig = `feedback:${fbStable}`;
      }

      // Fix 3: when this turn was REVERTED, fold its signature back onto the
      // prior one (when there was a prior failing turn) so a repeated regress→
      // revert loop registers as a stall. If there was no prior signature, keep
      // this turn's computed signature — it is itself stable for an identical
      // regression, so the NEXT reverted turn still matches and the counter
      // advances. Either way the normal (non-revert) path is untouched.
      if (reverted && priorFailureSig !== undefined) {
        turnFailureSig = priorFailureSig;
      }

      if (turnFailureSig === state.lastFailureSignature) {
        // Same failure again — increment stall counter.
        state.stallCount = (state.stallCount ?? 0) + 1;
      } else {
        // Different failure — reset stall counter.
        state.stallCount = 0;
      }
      state.lastFailureSignature = turnFailureSig;

      // Fire redraft when stall limit reached and we haven't exhausted redrafts.
      // Yield to the carousel in set-mode: redrafting the SAME file's prompt is
      // useless when the real remaining bug is in a DIFFERENT file, and the
      // carousel block below RESETS stallCount when it fires — if redraft ran
      // first it would zero stallCount and the carousel trigger below would
      // never see it reach STALL_LIMIT.
      if (!carouselActive && state.stallCount >= STALL_LIMIT && (state.redraftCount ?? 0) < MAX_REDRAFTS) {
        redraftNext = true;
        redraftStrategyHint = rotateStrategy(state.redraftCount ?? 0);
        state.stallCount = 0;
        state.lastFailureSignature = undefined;
        state.redraftCount = (state.redraftCount ?? 0) + 1;
        turnRedrafted = true;
      }

      // Set-carousel advance: fires on STALL ALONE (not gated on exhausting
      // redrafts) so it triggers well within a bounded eval's turn budget. The
      // helper itself still enforces the 2-sweep cap, length>1, index-mod-length
      // advance, and the fresh-budget reset (stallCount/redraftCount/
      // lastFailureSignature) on the new focus.
      if (carouselActive && (state.stallCount ?? 0) >= STALL_LIMIT) {
        advanceCarousel(state, state.editablePaths!, {
          stallLimit: STALL_LIMIT,
          maxRedrafts: MAX_REDRAFTS,
        });
      }
    } else {
      // Non-failing outcome (solved / clean / none) resets the stall counter.
      state.stallCount = 0;
      state.lastFailureSignature = undefined;
    }

    // R2: when the failure reached a source line (a runtime throw), read a tight
    // window around it so the next prompt shows the model exactly where to look.
    let failureLocation: { file: string; line: number; window: string } | undefined;
    if (LOCALIZE && verdict?.diagnostic?.sourceFile && verdict.diagnostic.sourceLine) {
      const abs = path.isAbsolute(verdict.diagnostic.sourceFile)
        ? verdict.diagnostic.sourceFile
        : path.resolve(state.repoRoot, verdict.diagnostic.sourceFile);
      // Only surface locations inside the repo — never a node_modules/bun frame.
      if (abs.startsWith(path.resolve(state.repoRoot) + sep)) {
        failureLocation =
          (await readFailureWindow(abs, verdict.diagnostic.sourceLine, state.repoRoot)) ??
          undefined;
      }
    }

    // R2 upper-bound PROBE (SMALLCODE_R2_FORCE_LINE=relpath:line). When this turn
    // failed with a diagnostic but produced no natural throw-location (a value
    // mismatch's trace stops at the test line — see failure-extract.ts), force the
    // R2 window onto the given source line. This measures the CEILING of
    // externalized localization: it hands the model a line the harness could NOT
    // itself derive for an assertion mismatch, so it is a measurement knob ONLY,
    // never a shipped default. If handing the exact line lifts a floor, a real
    // assertion-failure localization oracle is worth building; if not, R2 is the
    // wrong lever for that task class.
    if (!failureLocation && env.r2ForceLine && verdict?.diagnostic) {
      const sepIdx = env.r2ForceLine.lastIndexOf(":");
      const rel = sepIdx > 0 ? env.r2ForceLine.slice(0, sepIdx) : "";
      const forcedLine = sepIdx > 0 ? parseInt(env.r2ForceLine.slice(sepIdx + 1), 10) : NaN;
      if (rel && Number.isFinite(forcedLine) && forcedLine > 0) {
        const abs = path.resolve(state.repoRoot, rel);
        if (abs.startsWith(path.resolve(state.repoRoot) + sep)) {
          failureLocation = (await readFailureWindow(abs, forcedLine, state.repoRoot)) ?? undefined;
        }
      }
    }

    // SMALLCODE_RAD_HINT (model-side lever): when this turn failed and its edit
    // left a read-after-delete ordering bug (`X.delete(K); X.set(K, X.get(K))`)
    // on the locked target, stash a targeted hint so the NEXT prompt surfaces it
    // and the MODEL reorders the read. Purely a prompt signal — NOT a harness
    // rescue, so any resulting pass stays attributed to the model. Mirrors the
    // failureLocation computation above and the same conditional-spread on addTurn.
    let readAfterDelete: { object: string; key: string; line: number; hint: string } | undefined;
    if (env.radHint && verdict?.outcome === "failing" && state.lockedTargetPath !== undefined) {
      // Detect on the model's ATTEMPTED content this turn, NOT disk: a read-after-
      // delete edit that stores undefined regresses green tests and is reverted off
      // disk (disk goes back to pristine), so the pattern survives only in this
      // turn's applyResults newContent. Fall back to disk when the target wasn't
      // edited this turn (e.g. an off-target turn) but was left in a bad state earlier.
      const attempt =
        applyResults.find(
          (a) =>
            a.newContent !== undefined &&
            (a.effectivePath ?? a.filePath) === state.lockedTargetPath,
        )?.newContent ??
        latestAttemptContent(state, state.lockedTargetPath) ??
        (await readFileFn(state.lockedTargetPath));
      if (attempt) {
        const f = detectReadAfterDelete(attempt)[0];
        if (f !== undefined) {
          readAfterDelete = { object: f.object, key: f.key, line: f.deleteLine, hint: f.hint };
        }
      }
    }

    const turn: TurnRecord = {
      turn: state.turns.length + 1,
      goalId: goal.id,
      prompt: turnPrompt,
      rawResponse,
      reasoning,
      answer,
      toolCalls,
      toolResults,
      editBlocks,
      applyResults,
      promptTokens,
      completionTokens,
      timestamp: Date.now(),
      ...(turnFailureSig !== undefined && { failureSignature: turnFailureSig }),
      ...(turnRedrafted && { redrafted: true }),
      ...(turnAnswerNow && { answerNow: true }),
      ...(verdict?.diagnostic && { diagnostic: verdict.diagnostic }),
      ...(failureLocation && { failureLocation }),
      ...(readAfterDelete && { readAfterDelete }),
      ...(revertedNewFailures && { reverted: { newFailures: revertedNewFailures } }),
    };

    addTurn(state, turn);
    await saveState(state, statePath);

    const hasFinish = parsedToolCalls.some((tc) => tc.name === "finish" && tc.success);

    // Early-stop: "solved" (tests green) is proven complete — lock it in and stop
    // before a later turn can regress it. "clean"/"failing" do not early-stop; for
    // untested changes the oracle's value is the feedback (type errors surfaced,
    // no-tests not treated as a hard fail), while completion still flows through
    // the model's finish → goal-advance → goal-exhaustion path below.
    if (verdict?.outcome === "solved") {
      for (const g of state.goals) g.status = "done";
      state.status = "done";
      state.verified = true;
      await saveState(state, statePath);
      break;
    }

    // Off-task-drift guard (dogfood #1 blocker): when the harness confidently
    // pinned a single edit target this turn (`context.targetFile`) AND the oracle
    // still reports the same test failing, do NOT let `finish()` advance the goal
    // index onto a later sub-goal ("write tests"/"run tests" — the planner's own
    // shape for a bug-fix task). Advancing there swaps the prompt's "Current
    // Action" and the retrieval query away from the fix file entirely, which is
    // exactly how the model wandered into unrelated files in the live dogfood
    // (turns 2-8 edited src/verify/oracle.ts, metrics-store.ts, review.ts — never
    // args.ts again). Staying on the SAME goal means next turn's getContext(goal
    // .description) re-resolves the identical target file, keeping the model
    // anchored until the test actually goes green (verdict.outcome flips to
    // "solved" above and breaks the loop) or the model exhausts other goals via
    // a DIFFERENT signal. Multi-file/multi-goal work is unaffected: this only
    // fires when BOTH a confident single target AND a specific failing test are
    // present, AND there IS a later goal to drift onto (`currentGoalIndex + 1 <
    // goals.length`) — a single-goal task has nothing to wander into, so
    // advancing there just ends the run exactly as before (the grader/BoN
    // caller judges the outcome from the oracle, not from `status`).
    const hasNextGoal = state.currentGoalIndex + 1 < state.goals.length;
    const anchorActive =
      hasNextGoal && context.targetFile !== undefined && verdict?.outcome === "failing";
    if (hasFinish && !anchorActive) {
      advanceGoal(state);
      await saveState(state, statePath);
    }

    // Check maxTurns
    if (state.turns.length >= state.maxTurns) {
      state.status = "max_turns";
      await saveState(state, statePath); // FIX #5: persist max_turns so state.json never shows "running"
      break;
    }
  }

  // Harness-side operator-mutation repair (SMALLCODE_MUTATION_REPAIR, default off).
  // Last resort: the model loop ended UNSOLVED in fix-mode (red baseline) with a
  // locked fix-target. For the wrong-comparison-operator bug class the mri
  // forensics mapped, NO model-side lever moves the needle (R2 line-handing, 32b,
  // minimal-edit all ~0) — but the operator space is tiny and the oracle is
  // deterministic, so the harness brute-forces it: flip each comparison operator
  // in the target file, run the real oracle, keep the first fully-green candidate.
  // Only fires on failing runs, so it never slows a successful one.
  // Gate: a compile/load red (missing export/module, syntax error, unresolved
  // import) can NEVER be satisfied by flipping an operator or hoisting a
  // statement in the target file — the symbol/parse failure survives every
  // candidate. Firing anyway churns the full oracle over every flip for nothing
  // (dogfood 2026-07-07: an add-a-function task whose red was `Export named
  // 'wilsonCI' not found` burned ~36 suite runs across 2 rungs). Only brute-force
  // when the baseline red is a genuine assertion/logic failure (loadError false).
  if (
    !state.verified &&
    fixModeBaseline &&
    state.lockedTargetPath !== undefined &&
    testBaseline.loadError &&
    (env.mutationRepair || env.statementRepair || env.literalRepair)
  ) {
    console.error(
      `[repair] skipped operator/statement/literal repair on ${state.lockedTargetPath}: baseline red is a compile/load error (missing symbol, syntax, or unresolved import) — no operator/statement/literal flip can satisfy it.`,
    );
  }
  // All last-resort repair passes run inside ONE try/catch so a throw in any of them
  // (a `bun test` timeout, an fs error, anything) can NEVER escape runLoop and skip
  // the final-state guard below — the guard is the "never leave the repo worse than
  // found" backstop and must always get to run. The repair fns already restore the
  // model's edit on their own internal throws; this outer catch covers everything
  // else in these blocks (addTurn/saveState) so the guard is unconditionally reached.
  // (Dogfood 2026-07-08: an unguarded repair throw left the repo worse AND skipped
  // the guard — no log, finalStateReverted null.)
  try {
    if (
      env.mutationRepair &&
      !state.verified &&
      fixModeBaseline &&
      state.lockedTargetPath !== undefined &&
      !testBaseline.loadError
    ) {
      const repaired = await runOperatorMutationRepair(
        state,
        testBaseline,
        readFileFn,
        // journalWrite (not raw writeFileFn): a repair pass is a SECOND on-disk
        // write path — a crash mid-repair must be crash-recoverable too, so its
        // first write to the target records the pre-repair bytes in the journal.
        journalWrite,
      );
      if (repaired !== null) {
        console.error(
          `[mutation-repair] SOLVED ${state.lockedTargetPath} via ${repaired.label} at line ${repaired.line} (after ${repaired.attempts} candidate${repaired.attempts === 1 ? "" : "s"}).`,
        );
        for (const g of state.goals) g.status = "done";
        state.status = "done";
        state.verified = true;
        addTurn(state, {
          turn: state.turns.length + 1,
          goalId: currentGoal(state)?.id ?? state.goals[0]?.id ?? "mutation-repair",
          prompt: "",
          rawResponse: "",
          answer: `[harness] operator-mutation repair: ${state.lockedTargetPath} ${repaired.label} @L${repaired.line}`,
          toolCalls: [],
          toolResults: [],
          editBlocks: [],
          applyResults: [
            { filePath: state.lockedTargetPath, status: "applied", diff: repaired.label },
          ],
          promptTokens: 0,
          completionTokens: 0,
          timestamp: Date.now(),
          mutationRepair: {
            label: repaired.label,
            line: repaired.line,
            attempts: repaired.attempts,
          },
        } as TurnRecord);
        await saveState(state, statePath);
      }
    }

    // Harness-side literal-mutation repair (SMALLCODE_LITERAL_REPAIR, default
    // off). Second last-resort pass for a DISJOINT bug shape from
    // operator-mutation: a wrong integer CONSTANT (no operator to flip).
    // Guarded by `!state.verified` so it never runs if the model loop OR
    // operator-mutation already solved the task. Iterates the multi-file
    // editable set (not just the single locked target) — see runLiteralRepair.
    if (
      env.literalRepair &&
      !state.verified &&
      fixModeBaseline &&
      state.lockedTargetPath !== undefined &&
      !testBaseline.loadError
    ) {
      const repaired = await runLiteralRepair(state, testBaseline, readFileFn, journalWrite);
      if (repaired !== null) {
        console.error(
          `[literal-repair] SOLVED ${repaired.file} via ${repaired.label} at line ${repaired.line} (after ${repaired.attempts} candidate${repaired.attempts === 1 ? "" : "s"}).`,
        );
        for (const g of state.goals) g.status = "done";
        state.status = "done";
        state.verified = true;
        addTurn(state, {
          turn: state.turns.length + 1,
          goalId: currentGoal(state)?.id ?? state.goals[0]?.id ?? "literal-repair",
          prompt: "",
          rawResponse: "",
          answer: `[harness] literal-mutation repair: ${repaired.file} ${repaired.label} @L${repaired.line}`,
          toolCalls: [],
          toolResults: [],
          editBlocks: [],
          applyResults: [
            { filePath: repaired.file, status: "applied", diff: repaired.label },
          ],
          promptTokens: 0,
          completionTokens: 0,
          timestamp: Date.now(),
          mutationRepair: {
            label: `${repaired.label} (${repaired.file})`,
            line: repaired.line,
            attempts: repaired.attempts,
          },
        } as TurnRecord);
        await saveState(state, statePath);
      }
    }

    // Harness-side statement-repair (SMALLCODE_STATEMENT_REPAIR, default off).
    // Second last-resort pass for a DISJOINT bug shape from operator-mutation: the
    // read-after-delete ordering bug (`X.delete(K); X.set(K, X.get(K))`) that no
    // operator flip fixes. Guarded by `!state.verified` so it never runs if the
    // model loop OR operator-mutation already solved the task. Deterministically
    // hoists the read before the delete, runs the real oracle, keeps it if fully
    // green — recorded as a harness rescue (mutationRepair) so pass-quality
    // classification attributes it to the harness, not the model.
    if (
      env.statementRepair &&
      !state.verified &&
      fixModeBaseline &&
      state.lockedTargetPath !== undefined &&
      !testBaseline.loadError
    ) {
      const repaired = await runStatementRepair(state, testBaseline, readFileFn, journalWrite);
      if (repaired !== null) {
        console.error(
          `[statement-repair] SOLVED ${state.lockedTargetPath} via ${repaired.label} at line ${repaired.line} (after ${repaired.attempts} candidate${repaired.attempts === 1 ? "" : "s"}).`,
        );
        for (const g of state.goals) g.status = "done";
        state.status = "done";
        state.verified = true;
        addTurn(state, {
          turn: state.turns.length + 1,
          goalId: currentGoal(state)?.id ?? state.goals[0]?.id ?? "statement-repair",
          prompt: "",
          rawResponse: "",
          answer: `[harness] statement-repair: ${state.lockedTargetPath} ${repaired.label} @L${repaired.line}`,
          toolCalls: [],
          toolResults: [],
          editBlocks: [],
          applyResults: [
            { filePath: state.lockedTargetPath, status: "applied", diff: repaired.label },
          ],
          promptTokens: 0,
          completionTokens: 0,
          timestamp: Date.now(),
          mutationRepair: {
            label: repaired.label,
            line: repaired.line,
            attempts: repaired.attempts,
          },
        } as TurnRecord);
        await saveState(state, statePath);
      }
    }
  } catch (err) {
    // A repair pass threw; log and fall through UNSOLVED so the guard still runs.
    console.error(
      `[repair] pass aborted (${err instanceof Error ? err.message : String(err)}) — handing off to the final-state guard.`,
    );
  }

  // Final-state regression guard (SMALLCODE_FINAL_STATE_GUARD, default off). Runs
  // absolutely last, only when the run is still UNSOLVED after the model loop AND
  // every repair pass: if the end-of-run disk state is strictly worse than the
  // run-start baseline, revert every touched file to pristine so the run can
  // never leave the repo worse than it found it. No-op on solved runs (green
  // disk is never worse) and on unsolved-but-not-worse runs (partial progress is
  // preserved). Eval-neutral: an unsolved trial stays unsolved either way.
  // Fail-closed terminal finalize (E1-T4). The guard is the "never leave worse"
  // net, but the guard call itself — and its `saveState`, and `markClean` — sit
  // BELOW the repair try/catch, so a throw here (e.g. `captureTestBaseline`'s
  // `bun test` spawn failing, or a disk error on save) would escape `runLoop`
  // with the repo possibly left worse and the journal not yet consumed. Wrap it:
  // on ANY throw, replay the write-ahead journal to roll the run back to its
  // exact pre-run state BEFORE propagating, so an internal error can never leave
  // the repo worse than baseline (fail-closed). A clean pass runs the guard then
  // drops the journal (markClean) — a crash before that leaves it for the next
  // run to replay.
  const guardFn = deps.finalStateGuardFn ?? runFinalStateGuard;
  try {
    if (env.finalStateGuard && !state.verified) {
      if (await guardFn(state, testBaseline, writeFileFn, readFileFn)) {
        await saveState(state, statePath);
      }
    }
    if (journalOn) await markClean(state.repoRoot);
  } catch (err) {
    if (journalOn) {
      try {
        const rec = await recoverIfNeeded(state.repoRoot, writeFileFn, rmFileFn);
        if (rec.recovered) {
          console.error(
            `[final-state-guard] the terminal guard/finalize step threw — rolled the run back to its ` +
              `pre-run state (${rec.restored.length + rec.deleted.length} file(s)) so the repo is left no ` +
              `worse than baseline.`,
          );
        }
      } catch {
        // Recovery is best-effort; never mask the original error with a new one.
      }
    }
    throw err;
  }

  return state;
}
