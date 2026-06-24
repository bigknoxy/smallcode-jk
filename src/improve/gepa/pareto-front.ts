/**
 * Pareto-front maintenance and selection (2b).
 *
 * dominates(a, b): a Pareto-dominates b when a ≥ b on every task and strictly
 * greater on at least one task.
 *
 * ParetoFront keeps a non-dominated set (size-capped at populationCap).
 * select() uses the GEPA weighting scheme: for each task collect the front
 * candidates achieving the maximum score on that task; sample a candidate
 * weighted by the count of tasks it individually wins; break ties uniformly.
 */

import type { Candidate } from "./types.ts";

export function dominates(a: Candidate, b: Candidate, taskIds: string[]): boolean {
  if (taskIds.length === 0) return false;
  let strictlyBetter = false;
  for (const tid of taskIds) {
    const sa = a.scores[tid] ?? 0;
    const sb = b.scores[tid] ?? 0;
    if (sa < sb) return false; // a is worse on this task → cannot dominate
    if (sa > sb) strictlyBetter = true;
  }
  return strictlyBetter;
}

export class ParetoFront {
  private _members: Candidate[] = [];
  private readonly _taskIds: string[];
  private readonly _populationCap: number;

  constructor(taskIds: string[], populationCap: number) {
    this._taskIds = taskIds;
    this._populationCap = populationCap;
  }

  /**
   * Attempt to add a candidate to the front.
   *
   * Returns true if the candidate was added (i.e. it was not dominated by any
   * existing member).  Any existing members that are dominated by the new
   * candidate are evicted.  When the cap would be exceeded after evictions,
   * the weakest member (lowest meanScore) is dropped.
   */
  add(candidate: Candidate): boolean {
    // Reject if dominated by any existing member
    for (const m of this._members) {
      if (dominates(m, candidate, this._taskIds)) {
        return false;
      }
    }

    // Evict all existing members that the new candidate dominates
    this._members = this._members.filter((m) => !dominates(candidate, m, this._taskIds));

    this._members.push(candidate);

    // Enforce population cap — drop the member with the lowest meanScore
    while (this._members.length > this._populationCap) {
      let minIdx = 0;
      let minScore = this._members[0]?.meanScore ?? 0;
      for (let i = 1; i < this._members.length; i++) {
        const s = this._members[i]?.meanScore ?? 0;
        if (s < minScore) {
          minScore = s;
          minIdx = i;
        }
      }
      this._members.splice(minIdx, 1);
    }

    return true;
  }

  members(): Candidate[] {
    return [...this._members];
  }

  /**
   * GEPA selection:
   * 1. For each task find the maximum score achieved by any front member.
   * 2. Collect the set of front members that achieve that maximum on the task
   *    (i.e. "specialists" for that task).
   * 3. Each candidate accumulates a weight equal to the number of tasks for
   *    which it is a specialist.
   * 4. Sample one candidate proportional to its weight using the injected rng.
   *
   * Falls back to uniform sampling when all weights are zero (can happen when
   * every task has a degenerate zero-score front).
   */
  select(rng: () => number): Candidate {
    if (this._members.length === 0) {
      throw new Error("ParetoFront.select called on empty front");
    }
    if (this._members.length === 1) {
      return this._members[0] as Candidate;
    }

    // Build weight map: candidateId → count of tasks it leads
    const weights = new Map<string, number>();
    for (const m of this._members) weights.set(m.id, 0);

    for (const tid of this._taskIds) {
      let maxScore = -Infinity;
      for (const m of this._members) {
        const s = m.scores[tid] ?? 0;
        if (s > maxScore) maxScore = s;
      }
      for (const m of this._members) {
        const s = m.scores[tid] ?? 0;
        if (s >= maxScore) {
          weights.set(m.id, (weights.get(m.id) ?? 0) + 1);
        }
      }
    }

    const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);

    if (totalWeight === 0) {
      // Degenerate: all zero → uniform sample
      const idx = Math.floor(rng() * this._members.length);
      return this._members[idx] as Candidate;
    }

    // Weighted random selection
    let threshold = rng() * totalWeight;
    for (const m of this._members) {
      threshold -= weights.get(m.id) ?? 0;
      if (threshold <= 0) return m;
    }
    // Rounding safety
    return this._members[this._members.length - 1] as Candidate;
  }
}
