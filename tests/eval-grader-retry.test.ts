/**
 * Tests for the deterministic-grader infra-error retry guard
 * (src/eval/graders/deterministic.ts). The guard must:
 *   (a) retry a transient infra error (e.g. InvalidLockfileVersion) and succeed,
 *   (b) NEVER retry a real test failure — even when an infra signature happens
 *       to also appear in the output (the two-guard rule: retry only when zero
 *       test verdicts were parsed),
 *   (c) after exhausting retries, report verdict=error with details.infraError.
 *
 * Controlled output is injected via a tiny counter-based shell script set as the
 * grader command, so we can simulate "fail once then pass", "always fail with a
 * real ✗", and "always infra-error".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeterministicGrader } from "../src/eval/graders/deterministic.ts";
import type { DeterministicTestsGrader } from "../src/eval/types.ts";

let dir: string;
const prevRetries = process.env["SMALLCODE_GRADER_RETRIES"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grader-retry-"));
  process.env["SMALLCODE_GRADER_RETRIES"] = "1"; // 2 attempts total
});

afterEach(async () => {
  if (prevRetries === undefined) delete process.env["SMALLCODE_GRADER_RETRIES"];
  else process.env["SMALLCODE_GRADER_RETRIES"] = prevRetries;
  await rm(dir, { recursive: true, force: true });
});

async function writeRunner(body: string): Promise<void> {
  const path = join(dir, "runner.sh");
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`, "utf-8");
  await chmod(path, 0o755);
}

const grader: DeterministicTestsGrader = {
  type: "deterministic_tests",
  required: ["tests/x.test.ts"],
  command: "bash runner.sh",
};

function attemptCount(): Promise<string> {
  return Bun.file(join(dir, "c")).text().catch(() => "0");
}

describe("deterministic grader infra-retry", () => {
  it("(a) retries a transient lockfile error and then passes", async () => {
    await writeRunner(`
n=$(cat c 2>/dev/null || echo 0); n=$((n+1)); echo $n > c
if [ "$n" -eq 1 ]; then
  echo "InvalidLockfileVersion: failed to parse lockfile" >&2
  exit 1
else
  echo "✓ tests/x.test.ts"
  exit 0
fi`);
    const r = await runDeterministicGrader(grader, dir);
    expect(r.verdict).toBe("pass");
    expect((await attemptCount()).trim()).toBe("2"); // it retried once
  });

  it("(b) does NOT retry a real test failure even if an infra string is present", async () => {
    await writeRunner(`
n=$(cat c 2>/dev/null || echo 0); n=$((n+1)); echo $n > c
echo "✗ tests/x.test.ts"
echo "InvalidLockfileVersion" >&2
exit 1`);
    const r = await runDeterministicGrader(grader, dir);
    expect(r.verdict).toBe("fail");
    expect(r.details?.["infraError"]).toBeUndefined();
    expect((await attemptCount()).trim()).toBe("1"); // ran exactly once — no masking
  });

  it("(c) reports infraError after exhausting retries", async () => {
    await writeRunner(`
n=$(cat c 2>/dev/null || echo 0); n=$((n+1)); echo $n > c
echo "InvalidLockfileVersion: failed to parse lockfile" >&2
exit 1`);
    const r = await runDeterministicGrader(grader, dir);
    expect(r.verdict).toBe("error");
    expect(r.details?.["infraError"]).toBe(true);
    expect(r.details?.["attempts"]).toBe(2);
    expect((await attemptCount()).trim()).toBe("2");
  });
});
