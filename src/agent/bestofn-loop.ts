import { runLoop, type LoopDependencies } from "./loop.ts";
import type { AgentState } from "./types.ts";
import type { ContextBundle } from "@/context/types.ts";

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
  const states: AgentState[] = [];

  for (let i = 0; i < opts.n; i++) {
    const { state, statePath, getContext } = await opts.setup(i);
    const deps: LoopDependencies = {
      ...opts.deps,
      samplingOverride: { temperature: temps[i] ?? temps[temps.length - 1] },
    };

    const final = await runLoop(state, statePath, deps, getContext);
    states.push(final);

    if (await opts.verify(i)) {
      return {
        passed: true,
        attemptsUsed: i + 1,
        winningAttempt: i,
        temperatures: temps.slice(0, i + 1),
        states,
      };
    }
  }

  return {
    passed: false,
    attemptsUsed: opts.n,
    winningAttempt: null,
    temperatures: temps.slice(0, opts.n),
    states,
  };
}
