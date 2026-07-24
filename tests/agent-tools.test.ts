import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BestOfNOptions } from "../src/agent/bestofn.ts";
import { selectBestCandidate } from "../src/agent/bestofn.ts";
import type { ToolContext } from "../src/agent/tools.ts";
import { ApprovalRequiredError, executeTool, repoSubprocessEnv } from "../src/agent/tools.ts";
import type { ModelProfile } from "../src/models/types.ts";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types.ts";

// ---------------------------------------------------------------------------
// Temp dir setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "smallcode-agent-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    repoRoot: tmpDir,
    allowedCommands: ["bun"],
    requireApproval: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("read_file", () => {
  it("1. reads an existing file correctly", async () => {
    const filePath = path.join(tmpDir, "hello.txt");
    await writeFile(filePath, "hello world");

    const result = await executeTool({ name: "read_file", args: { path: "hello.txt" } }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.output).toBe("hello world");
  });

  it("2. returns (file not found) for missing file", async () => {
    const result = await executeTool(
      { name: "read_file", args: { path: "does-not-exist.txt" } },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("(file not found)");
  });

  it("3. truncates large file with [truncated]", async () => {
    const filePath = path.join(tmpDir, "large.txt");
    const bigContent = "x".repeat(9000);
    await writeFile(filePath, bigContent);

    const result = await executeTool({ name: "read_file", args: { path: "large.txt" } }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.output).toContain("[truncated]");
    expect(result.output.length).toBeLessThanOrEqual(8000 + "\n[truncated]".length);
  });

  it("4. rejects path traversal (../../../etc/passwd)", async () => {
    const result = await executeTool(
      { name: "read_file", args: { path: "../../../etc/passwd" } },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/traversal/i);
  });
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

describe("write_file", () => {
  it("5. creates file and parent dirs", async () => {
    const result = await executeTool(
      {
        name: "write_file",
        args: { path: "subdir/nested/new.ts", content: "export const x = 1;" },
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const written = await readFile(path.join(tmpDir, "subdir/nested/new.ts"), "utf8");
    expect(written).toBe("export const x = 1;");
  });

  it("6. with requireApproval=true throws ApprovalRequiredError", async () => {
    let thrown: unknown;
    try {
      await executeTool(
        { name: "write_file", args: { path: "safe.txt", content: "data" } },
        makeCtx({ requireApproval: true }),
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApprovalRequiredError);
    const e = thrown as ApprovalRequiredError;
    expect(e.toolName).toBe("write_file");
  });
});

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------

describe("run_command", () => {
  it("7. allowed command (bun --version) succeeds", async () => {
    const result = await executeTool(
      { name: "run_command", args: { cmd: "bun --version" } },
      makeCtx({ allowedCommands: ["bun"] }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatch(/\d+\.\d+/);
  });

  it("8. disallowed command returns error result (not throw)", async () => {
    let threw = false;
    let result: Awaited<ReturnType<typeof executeTool>> | undefined;
    try {
      result = await executeTool(
        { name: "run_command", args: { cmd: "rm -rf /" } },
        makeCtx({ allowedCommands: ["bun"] }),
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/not in allowlist/i);
  });
});

// ---------------------------------------------------------------------------
// run_tests
// ---------------------------------------------------------------------------

describe("run_tests", () => {
  it("9. in a project with passing tests returns success=true", async () => {
    // Use the real project root
    const projectRoot = path.resolve(import.meta.dir, "..");
    const result = await executeTool(
      { name: "run_tests", args: { pattern: "tests/reasoning.test.ts" } },
      makeCtx({ repoRoot: projectRoot }),
    );

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// think
// ---------------------------------------------------------------------------

describe("think", () => {
  it("10. always returns success=true", async () => {
    const result = await executeTool(
      { name: "think", args: { content: "I should check the file first." } },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("");
  });
});

// ---------------------------------------------------------------------------
// finish
// ---------------------------------------------------------------------------

describe("finish", () => {
  it("11. returns success=true with summary in output", async () => {
    const result = await executeTool(
      { name: "finish", args: { summary: "Task completed successfully." } },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("Task completed successfully.");
  });
});

// ---------------------------------------------------------------------------
// selectBestCandidate
// ---------------------------------------------------------------------------

const stubProfile: ModelProfile = {
  id: "stub-model",
  label: "Stub",
  contextWindow: 4096,
  samplingDefaults: { temperature: 0.7, top_p: 0.9, top_k: -1, max_tokens: 512 },
  supportsGrammar: false,
  supportsJsonSchema: false,
};

const stubRequest: CompletionRequest = {
  messages: [{ role: "user", content: "test" }],
  model: "stub-model",
};

describe("selectBestCandidate", () => {
  it("12. n=1 returns single candidate without calling verifier", async () => {
    let verifierCalled = 0;

    const provider: Provider = {
      complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
        rawContent: "answer text",
        model: "stub-model",
        finishReason: "stop",
      }),
      stream: async function* () {
        yield { delta: "", done: true };
      },
    };

    const opts: BestOfNOptions = {
      n: 1,
      provider,
      profile: stubProfile,
      repoRoot: tmpDir,
      readFile: async () => null,
      writeFile: async () => {},
      runVerifier: async () => {
        verifierCalled++;
        return { checksRun: 1, checksPassed: 1 };
      },
    };

    const result = await selectBestCandidate(stubRequest, opts);

    expect(result.n).toBe(1);
    expect(result.all.length).toBe(1);
    expect(result.winner.rawResponse).toBe("answer text");
    expect(verifierCalled).toBe(0);
    expect(result.winner.verifierScore).toBe(0);
  });

  it("13. n=2 calls verifier twice, returns higher-scoring candidate", async () => {
    let verifierCalled = 0;
    let callIndex = 0;

    // First response scores 0/1, second scores 1/1
    const scores = [0, 1];

    const provider: Provider = {
      complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
        rawContent: `response-${callIndex++}`,
        model: "stub-model",
        finishReason: "stop",
      }),
      stream: async function* () {
        yield { delta: "", done: true };
      },
    };

    let scoreIdx = 0;
    const opts: BestOfNOptions = {
      n: 2,
      provider,
      profile: stubProfile,
      repoRoot: tmpDir,
      readFile: async () => null,
      writeFile: async () => {},
      runVerifier: async () => {
        const passed = scores[scoreIdx++] ?? 0;
        verifierCalled++;
        return { checksRun: 1, checksPassed: passed };
      },
    };

    const result = await selectBestCandidate(stubRequest, opts);

    expect(result.n).toBe(2);
    expect(result.all.length).toBe(2);
    expect(verifierCalled).toBe(2);
    // Winner should be the candidate with verifierScore = 1 (index 1)
    expect(result.winner.verifierScore).toBe(1);
    expect(result.winner.index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// repoSubprocessEnv — the harness must NOT leak its own SMALLCODE_* control
// vars into the repo-under-repair's test/command subprocess. Surfaced by
// dogfooding smallcode ON smallcode: SMALLCODE_BASE_URL/MODEL set to reach the
// model flipped smallcode's OWN config tests red in the oracle, so a correct fix
// read as "still failing".
// ---------------------------------------------------------------------------

describe("repoSubprocessEnv", () => {
  it("strips SMALLCODE_* keys and keeps everything else", () => {
    const out = repoSubprocessEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      SMALLCODE_BASE_URL: "http://localhost:8910/v1",
      SMALLCODE_MODEL: "qwythos-9b",
      SMALLCODE_API_KEY: "sk-x",
      NODE_ENV: "test",
    });
    expect(out["PATH"]).toBe("/usr/bin");
    expect(out["HOME"]).toBe("/home/x");
    expect(out["NODE_ENV"]).toBe("test");
    expect(out["SMALLCODE_BASE_URL"]).toBeUndefined();
    expect(out["SMALLCODE_MODEL"]).toBeUndefined();
    expect(out["SMALLCODE_API_KEY"]).toBeUndefined();
  });

  it("drops undefined values", () => {
    const out = repoSubprocessEnv({ A: "1", B: undefined });
    expect(out["A"]).toBe("1");
    expect("B" in out).toBe(false);
  });

  it("run_tests spawns with SMALLCODE_* stripped (wiring guard)", async () => {
    // A test in the target repo that FAILS iff it can see a leaked SMALLCODE_* var.
    // If run_tests inherited the parent env, this would go red and the assertion
    // below (success === true) would fail — pinning the fix.
    const repo = await mkdtemp(path.join(tmpdir(), "smallcode-envleak-"));
    try {
      await writeFile(path.join(repo, "package.json"), '{"name":"t","type":"module"}');
      await writeFile(
        path.join(repo, "leak.test.ts"),
        'import { test, expect } from "bun:test";\n' +
          'test("no harness env leaked", () => {\n' +
          '  expect(process.env.SMALLCODE_LEAK_CANARY).toBeUndefined();\n' +
          "});\n",
      );
      const prior = process.env["SMALLCODE_LEAK_CANARY"];
      process.env["SMALLCODE_LEAK_CANARY"] = "leaked";
      try {
        const result = await executeTool(
          { name: "run_tests", args: {} },
          makeCtx({ repoRoot: repo }),
        );
        expect(result.success).toBe(true);
      } finally {
        if (prior === undefined) delete process.env["SMALLCODE_LEAK_CANARY"];
        else process.env["SMALLCODE_LEAK_CANARY"] = prior;
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
