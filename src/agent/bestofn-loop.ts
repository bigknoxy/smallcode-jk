import { runLoop, type LoopDependencies } from "./loop.ts";
import type { AgentState } from "./types.ts";
import type { ContextBundle } from "@/context/types.ts";
import type { Provider } from "@/provider/types.ts";
import type { ModelProfile } from "@/models/types.ts";

/** One rung of the R1 escalation ladder: the model to run a given attempt with. */
export interface EscalationRung {
  id: string;
  provider: Provider;
  profile: ModelProfile;
}

/**
 * Run-level oracle-verified Best-of-N.
 *
 * Runs the full agent loop up to N times — each a fresh, independent attempt at
 * the SAME task — and returns the first attempt whose verifier goes green. The
 * verifier (typically `bun test`) is a sound oracle: a green result means the
 * solution is correct, so "any attempt passed" == solved. This converts a noisy
 * pass@1 into pass@N(any) with zero selection error.
 *
 * Diversity matters: identical attempts give nothing, so each attempt samples at
 * a different temperature (a sweep around the model default, clamped to the
 * model's valid range by the caller). The model can still self-repair WITHIN an
 * attempt via the loop's per-turn test feedback; Best-of-N adds independent
 * restarts ON TOP of that.
 *
 * `setup` must produce a FRESH environment per attempt (e.g. a clean trial dir,
 * or a git-checkpoint restore) so attempts don't inherit each other's edits.
 * `verify` is the oracle: it returns true iff the attempt's final disk state
 * passes. The first true short-circuits — remaining attempts are not run.
 */
export interface BestOfNLoopOptions {
  /** Max independent attempts. n=1 is a plain single run. */
  n: number;
  /** Per-attempt temperatures. Defaults to a sweep around 1.0 in [0.7, 1.3]. */
  temperatures?: number[];
  /** Builds a fresh attempt environment. Called once per attempt. */
  setup: (attempt: number) => Promise<{
    state: AgentState;
    statePath: string;
    getContext: (goal: string) => Promise<ContextBundle>;
  }>;
  /** Oracle: did this attempt's final state pass? First true wins. */
  verify: (attempt: number) => Promise<boolean>;
  /** Loop deps minus the per-attempt sampling override (added internally). */
  deps: Omit<LoopDependencies, "samplingOverride">;
  /**
   * R1 model-escalation ladder. When set, attempt `i` runs with `models[i]`'s
   * provider+profile instead of `deps`' — letting a run escalate 3b→7b→14b as
   * cheaper attempts fail. Index is clamped to the last rung, so a 3-rung ladder
   * with n=5 reuses the top rung for attempts 3-4. Omit → every attempt uses
   * `deps` (plain temperature-swept Best-of-N, unchanged).
   */
  models?: EscalationRung[];
  /**
   * Test-only seam: override the agent loop. Defaults to the real `runLoop`
   * import. Lets tests drive Best-of-N control flow without a model WITHOUT
   * `mock.module`-ing loop.ts — a module mock is process-global and
   * unrestorable in bun, so it leaks the stub to every downstream test file that
   * imports the loop, whichever file order the platform picks (the cause of the
   * ubuntu-CI-only agent-loop failures). Production omits this → real `runLoop`.
   */
  runLoop?: typeof runLoop;
}

export interface BestOfNLoopResult {
  passed: boolean;
  /** How many attempts were actually run (≤ n; stops early on first pass). */
  attemptsUsed: number;
  /** Index of the winning attempt, or null if none passed. */
  winningAttempt: number | null;
  /** Temperatures actually used, in order. */
  temperatures: number[];
  /** Final state of each attempt run. */
  states: AgentState[];
  /** R1: model id used per attempt (base model id when no ladder), in order. */
  modelsUsed: string[];
  /** R1: model id of the winning attempt, or null if none passed. */
  winningModelId: string | null;
}

/**
 * A spread of temperatures around 1.0 within [0.7, 1.3]. VibeThinker-3B requires
 * temp ≥ 0.6 (it degrades at low temp), so the sweep stays warm. For n=1 this is
 * just [1.0]; larger n fans out symmetrically.
 */
export function defaultTemperatures(n: number): number[] {
  if (n <= 1) return [1.0];
  const lo = 0.7;
  const hi = 1.3;
  const step = (hi - lo) / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.round((lo + i * step) * 100) / 100);
}

export async function runBestOfNLoop(opts: BestOfNLoopOptions): Promise<BestOfNLoopResult> {
  const temps = opts.temperatures ?? defaultTemperatures(opts.n);
  const runLoopFn = opts.runLoop ?? runLoop;
  const states: AgentState[] = [];
  const modelsUsed: string[] = [];

  for (let i = 0; i < opts.n; i++) {
    const { state, statePath, getContext } = await opts.setup(i);
    // R1: pick this attempt's rung (clamped to the last). When no ladder is set,
    // rung is undefined and deps keeps the base provider/profile.
    const rung = opts.models ? opts.models[Math.min(i, opts.models.length - 1)] : undefined;
    // The loop sends `state.modelId` as the request model, so escalation must
    // retarget BOTH the request model id AND the profile (sampling + window).
    if (rung) state.modelId = rung.id;
    const deps: LoopDependencies = {
      ...opts.deps,
      ...(rung ? { provider: rung.provider, profile: rung.profile } : {}),
      samplingOverride: { temperature: temps[i] ?? temps[temps.length - 1] },
    };
    modelsUsed.push(rung?.id ?? opts.deps.profile?.id ?? "base");

    const final = await runLoopFn(state, statePath, deps, getContext);
    states.push(final);

    if (await opts.verify(i)) {
      return {
        passed: true,
        attemptsUsed: i + 1,
        winningAttempt: i,
        temperatures: temps.slice(0, i + 1),
        states,
        modelsUsed,
        winningModelId: modelsUsed[i] ?? null,
      };
    }
  }

  return {
    passed: false,
    attemptsUsed: opts.n,
    winningAttempt: null,
    temperatures: temps.slice(0, opts.n),
    states,
    modelsUsed,
    winningModelId: null,
  };
}
