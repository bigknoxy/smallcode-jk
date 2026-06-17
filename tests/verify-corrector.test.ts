import { describe, expect, it } from "bun:test";
import type { ModelProfile } from "../src/models/types.ts";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types.ts";
import { ReasoningHandler } from "../src/reasoning/handler.ts";
import { runSelfCorrection } from "../src/verify/corrector.ts";
import type { VerifySandboxConfig as SandboxConfig } from "../src/verify/sandbox.ts";
import {
  checkCommand,
  checkFilePath,
  defaultVerifySandboxConfig as defaultSandboxConfig,
} from "../src/verify/sandbox.ts";
import type { VerifyConfig, VerifyResult } from "../src/verify/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    repoRoot: "/tmp/repo",
    allowedCommands: ["bun", "bunx", "tsc"],
    requireApproval: false,
    dryRun: false,
    ...overrides,
  };
}

function makePassedVerifyResult(): VerifyResult {
  return {
    checks: [],
    passed: true,
    checksRun: 0,
    checksPassed: 0,
    failureSummary: "",
    totalDurationMs: 0,
  };
}

function makeFailedVerifyResult(summary = "lint failed"): VerifyResult {
  return {
    checks: [
      {
        kind: "lint",
        name: "biome",
        status: "failed",
        output: summary,
        durationMs: 10,
        exitCode: 1,
      },
    ],
    passed: false,
    checksRun: 1,
    checksPassed: 0,
    failureSummary: summary,
    totalDurationMs: 10,
  };
}

function makeVerifyConfig(maxCorrectionIterations = 3): VerifyConfig {
  return {
    repoRoot: "/tmp/repo",
    checkers: [],
    maxCorrectionIterations,
  };
}

function makeProfile(): ModelProfile {
  return {
    id: "test-model",
    label: "Test Model",
    contextWindow: 8192,
    samplingDefaults: {
      temperature: 0.7,
      top_p: 0.95,
      top_k: -1,
      max_tokens: 2048,
    },
    supportsGrammar: false,
    supportsJsonSchema: false,
  };
}

function makeProvider(response: string): Provider {
  return {
    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      return { rawContent: response, model: "test-model" };
    },
    async *stream(_req: CompletionRequest) {
      yield { delta: response, done: true };
    },
  };
}

function makeThrowingProvider(errorMsg: string): Provider {
  return {
    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      throw new Error(errorMsg);
    },
    async *stream(_req: CompletionRequest) {
      throw new Error(errorMsg);
      // biome-ignore lint/correctness/useYield lint/correctness/noUnreachable: required by interface; throw always fires
      yield { delta: "", done: true };
    },
  };
}

function makeReasoningHandler(): ReasoningHandler {
  return new ReasoningHandler({ open: "<think>", close: "</think>" });
}

// ---------------------------------------------------------------------------
// checkCommand tests
// ---------------------------------------------------------------------------

describe("checkCommand", () => {
  it("1. allowed binary returns allowed=true", () => {
    const result = checkCommand(["bun", "test"], makeSandboxConfig());
    expect(result.allowed).toBe(true);
    expect(result.dryRun).toBe(false);
  });

  it("2. disallowed binary returns allowed=false", () => {
    const result = checkCommand(["rm", "-rf", "/"], makeSandboxConfig());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("rm");
  });

  it("3. dryRun=true returns allowed=true with dryRun=true", () => {
    const result = checkCommand(["rm", "-rf", "/"], makeSandboxConfig({ dryRun: true }));
    expect(result.allowed).toBe(true);
    expect(result.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkFilePath tests
// ---------------------------------------------------------------------------

describe("checkFilePath", () => {
  it("4. path within repoRoot is allowed", () => {
    const config = makeSandboxConfig({ repoRoot: "/tmp/repo" });
    const result = checkFilePath("src/main.ts", config);
    expect(result.allowed).toBe(true);
  });

  it("5. path traversal ../../../etc/passwd is not allowed", () => {
    const config = makeSandboxConfig({ repoRoot: "/tmp/repo" });
    const result = checkFilePath("../../../etc/passwd", config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path traversal rejected");
  });

  it("6. absolute path /etc/passwd escaping repoRoot is not allowed", () => {
    const config = makeSandboxConfig({ repoRoot: "/tmp/repo" });
    const result = checkFilePath("/etc/passwd", config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Path traversal rejected");
  });
});

// ---------------------------------------------------------------------------
// defaultSandboxConfig tests
// ---------------------------------------------------------------------------

describe("defaultSandboxConfig", () => {
  it("7. includes bun and bunx in allowlist", () => {
    const config = defaultSandboxConfig("/tmp/repo");
    expect(config.allowedCommands).toContain("bun");
    expect(config.allowedCommands).toContain("bunx");
  });
});

// ---------------------------------------------------------------------------
// runSelfCorrection tests
// ---------------------------------------------------------------------------

describe("runSelfCorrection", () => {
  it("8. verify already passes → converged immediately, 0 iterations", async () => {
    const result = await runSelfCorrection(makeVerifyConfig(), {
      provider: makeProvider("no edits needed"),
      profile: makeProfile(),
      reasoningHandler: makeReasoningHandler(),
      runVerify: async () => makePassedVerifyResult(),
      applyEdits: async () => [],
      systemPrompt: "You are a code fixer.",
    });

    expect(result.converged).toBe(true);
    expect(result.iterationsUsed).toBe(0);
    expect(result.iterations).toHaveLength(0);
    expect(result.finalVerifyResult.passed).toBe(true);
  });

  it("9. verify fails once then passes → converged=true, iterationsUsed=1", async () => {
    let callCount = 0;
    const result = await runSelfCorrection(makeVerifyConfig(), {
      provider: makeProvider("no edits"),
      profile: makeProfile(),
      reasoningHandler: makeReasoningHandler(),
      runVerify: async () => {
        callCount++;
        // First call (initial) fails, second call (after correction) passes
        return callCount <= 1 ? makeFailedVerifyResult() : makePassedVerifyResult();
      },
      applyEdits: async () => [],
      systemPrompt: "You are a code fixer.",
    });

    expect(result.converged).toBe(true);
    expect(result.iterationsUsed).toBe(1);
    expect(result.finalVerifyResult.passed).toBe(true);
  });

  it("10. verify always fails → converged=false, iterationsUsed=maxCorrectionIterations", async () => {
    const maxIter = 3;
    const result = await runSelfCorrection(makeVerifyConfig(maxIter), {
      provider: makeProvider("no edits"),
      profile: makeProfile(),
      reasoningHandler: makeReasoningHandler(),
      runVerify: async () => makeFailedVerifyResult(),
      applyEdits: async () => [],
      systemPrompt: "You are a code fixer.",
    });

    expect(result.converged).toBe(false);
    expect(result.iterationsUsed).toBe(maxIter);
    expect(result.finalVerifyResult.passed).toBe(false);
  });

  it("11. provider throws → iteration recorded with applied=false, loop ends gracefully", async () => {
    const result = await runSelfCorrection(makeVerifyConfig(3), {
      provider: makeThrowingProvider("API unavailable"),
      profile: makeProfile(),
      reasoningHandler: makeReasoningHandler(),
      runVerify: async () => makeFailedVerifyResult(),
      applyEdits: async () => [],
      systemPrompt: "You are a code fixer.",
    });

    // Should not throw
    expect(result.converged).toBe(false);
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]?.applied).toBe(false);
    expect(result.iterationsUsed).toBe(1);
  });
});
