import type { EvalRunResult } from "../eval/types.ts";
import type { MetricsStore } from "./metrics-store.ts";
import type { MetricsSnapshot, RegressionCheckResult } from "./types.ts";

export interface GateConfig {
  threshold: number; // minimum pass@1 to pass gate (e.g. 0.9)
  allowDelta?: number; // allow pass@1 to drop by this much vs baseline (e.g. 0.05)
  baselineRunId?: string; // compare against this specific run; default: latest
}

export function checkRegression(
  current: EvalRunResult,
  baseline: MetricsSnapshot | null,
  config: GateConfig,
): RegressionCheckResult {
  const baselinePassAt1 = baseline?.overallPassAt1 ?? 0;
  const currentPassAt1 = current.overallPassAt1;
  const delta = currentPassAt1 - baselinePassAt1;
  const allowDelta = config.allowDelta ?? 0;

  const aboveThreshold = currentPassAt1 >= config.threshold;
  const deltaOk = baseline === null ? true : delta >= -allowDelta;
  const passed = aboveThreshold && deltaOk;

  // Find tasks that regressed compared to baseline
  const regressedTasks: string[] = [];
  if (baseline !== null) {
    for (const taskResult of current.taskResults) {
      const taskId = taskResult.task.id;
      const baselineTask = baseline.perTaskPassAt1[taskId];
      if (baselineTask !== undefined && taskResult.passAt1 < baselineTask) {
        regressedTasks.push(taskId);
      }
    }
  }

  let message: string;
  if (baseline === null) {
    message = `No baseline available. Current pass@1=${currentPassAt1.toFixed(3)}, threshold=${config.threshold}. ${passed ? "PASSED" : "FAILED (below threshold)"}`;
  } else {
    const deltaSign = delta >= 0 ? "+" : "";
    message =
      `pass@1: ${currentPassAt1.toFixed(3)} (baseline: ${baselinePassAt1.toFixed(3)}, delta: ${deltaSign}${delta.toFixed(3)}, allowDelta: ${allowDelta}, threshold: ${config.threshold}). ` +
      `Regressed tasks: [${regressedTasks.join(", ")}]. ${passed ? "PASSED" : "FAILED"}`;
  }

  return {
    passed,
    baselinePassAt1,
    currentPassAt1,
    delta,
    regressedTasks,
    threshold: config.threshold,
    message,
  };
}

export async function runGate(
  result: EvalRunResult,
  store: MetricsStore,
  config: GateConfig,
  now: number,
): Promise<RegressionCheckResult> {
  let baseline: MetricsSnapshot | null;

  if (config.baselineRunId !== undefined) {
    const history = await store.getHistory(result.suiteId);
    baseline = history.snapshots.find((s) => s.runId === config.baselineRunId) ?? null;
  } else {
    baseline = await store.getLatest(result.suiteId);
  }

  const gateResult = checkRegression(result, baseline, config);

  // Persist after checking (so baseline isn't the current run)
  await store.append(result, now);

  return gateResult;
}
