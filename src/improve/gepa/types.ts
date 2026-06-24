/**
 * GEPA types (2b).
 *
 * A Candidate carries a mutated PromptSet and its per-task score matrix.
 * GepaConfig defines the search budget.
 */

import type { PromptSet } from "../../agent/prompt-set.ts";
import type { Transcript } from "../../eval/types.ts";

export type { Transcript };

export interface Candidate {
  /** Unique identifier for this candidate. */
  id: string;
  /** The prompt variants this candidate carries. */
  prompts: PromptSet;
  /** ID of the parent candidate (null for the seed). */
  parentId: string | null;
  /** Generation number (0 = seed). */
  generation: number;
  /** Per-task passAt1 scores keyed by taskId. */
  scores: Record<string, number>;
  /** Mean of all per-task scores. */
  meanScore: number;
}

export interface GepaConfig {
  /** Task IDs that define the score vector (one dimension per task). */
  taskIds: string[];
  /** Maximum number of Pareto-front members to keep. */
  populationCap: number;
  /** Number of evolution generations to run. */
  maxGenerations: number;
  /** Number of trials per task when scoring a candidate. */
  trialsPerTask: number;
}

/** A single failed task instance passed to the mutator for reflection. */
export interface FailedInstance {
  taskId: string;
  transcript: Transcript;
}
