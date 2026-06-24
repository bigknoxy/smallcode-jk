/**
 * Reflective mutator interface (2b).
 *
 * A ReflectiveMutator takes a parent PromptSet and a list of failed-task
 * instances (transcripts where passAt1 < 1) and produces a mutated PromptSet.
 *
 * The interface is provider-agnostic and injectable, so:
 *   - Unit tests use MockMutator (deterministic, no model calls).
 *   - The smoke script can wire in a live LLM mutator once implemented.
 *
 * No live LLM mutator is implemented here — that is a later phase.
 */

import type { PromptSet } from "../../agent/prompt-set.ts";
import type { FailedInstance } from "./types.ts";

export interface ReflectiveMutator {
  /**
   * Given the parent prompts and a set of failed task transcripts, produce a
   * mutated PromptSet that addresses the identified failure modes.
   */
  mutate(parent: PromptSet, failures: FailedInstance[]): Promise<PromptSet>;
}

// ---------------------------------------------------------------------------
// MockMutator — deterministic, useful in unit tests and smoke scripts.
// ---------------------------------------------------------------------------

/**
 * Deterministically mutates a PromptSet by appending a versioned marker to
 * each prompt string.  Call count is exposed so tests can verify it was called.
 */
export class MockMutator implements ReflectiveMutator {
  public callCount = 0;
  public lastParent: PromptSet | null = null;
  public lastFailures: FailedInstance[] | null = null;

  async mutate(parent: PromptSet, failures: FailedInstance[]): Promise<PromptSet> {
    this.callCount++;
    this.lastParent = parent;
    this.lastFailures = failures;

    const tag = `[mutated-v${this.callCount}]`;
    return {
      system: `${parent.system} ${tag}`,
      planner: `${parent.planner} ${tag}`,
      reflection: `${parent.reflection} ${tag}`,
    };
  }
}
