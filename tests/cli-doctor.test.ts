import { describe, expect, it } from "bun:test";
import {
  buildDoctorChecks,
  type DoctorFacts,
  hasFatalFailure,
  renderDoctor,
} from "../src/cli/commands/doctor.ts";

const healthy: DoctorFacts = {
  bunVersion: "1.3.12",
  ollamaOnPath: true,
  endpoint: "http://localhost:11434",
  serverReachable: true,
  serverError: undefined,
  activeModel: "qwen2.5-coder:3b",
  installedModels: ["qwen2.5-coder:3b", "qwen2.5-coder:7b"],
  configOk: true,
  configError: undefined,
  modelRegistered: true,
  isGitRepo: true,
  hasTestRunner: true,
};

const find = (checks: ReturnType<typeof buildDoctorChecks>, name: string) =>
  checks.find((c) => c.name === name)!;

describe("buildDoctorChecks", () => {
  it("a fully healthy setup → every check ok, no fatal failure", () => {
    const checks = buildDoctorChecks(healthy);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(hasFatalFailure(checks)).toBe(false);
    expect(renderDoctor(checks)).toContain("✓ Ready to run.");
  });

  it("server down → P0 fail with the `ollama serve` fix + fatal", () => {
    const checks = buildDoctorChecks({
      ...healthy,
      serverReachable: false,
      serverError: "no response within 2000ms",
      installedModels: [],
    });
    const server = find(checks, "Ollama server");
    expect(server.ok).toBe(false);
    expect(server.level).toBe("P0");
    expect(server.fix).toContain("ollama serve");
    expect(hasFatalFailure(checks)).toBe(true);
    // Model-pulled can't be checked with the server down → downgraded to warn, not a second fatal.
    const pulled = find(checks, "Model pulled");
    expect(pulled.level).toBe("warn");
    expect(pulled.detail).toContain("can't check");
  });

  it("model not pulled (server up) → P0 fail with the exact `ollama pull <id>` fix", () => {
    const checks = buildDoctorChecks({ ...healthy, installedModels: ["qwen2.5-coder:7b"] });
    const pulled = find(checks, "Model pulled");
    expect(pulled.ok).toBe(false);
    expect(pulled.level).toBe("P0");
    expect(pulled.fix).toBe("ollama pull qwen2.5-coder:3b");
    expect(hasFatalFailure(checks)).toBe(true);
  });

  it("invalid config → P0 fail with `config init`, and the model-id check is skipped", () => {
    const checks = buildDoctorChecks({
      ...healthy,
      configOk: false,
      configError: "No config file found",
      activeModel: undefined,
      modelRegistered: false,
    });
    const cfg = find(checks, "Config");
    expect(cfg.ok).toBe(false);
    expect(cfg.fix).toContain("config init");
    expect(hasFatalFailure(checks)).toBe(true);
    expect(checks.find((c) => c.name === "Model id")).toBeUndefined(); // skipped when config invalid
  });

  it("unknown model id → P0 fail pointing at list-models", () => {
    const checks = buildDoctorChecks({ ...healthy, modelRegistered: false, activeModel: "typo-model" });
    const mid = find(checks, "Model id");
    expect(mid.ok).toBe(false);
    expect(mid.level).toBe("P0");
    expect(mid.fix).toContain("list-models");
  });

  it("no git / no test runner → WARN only, not fatal", () => {
    const checks = buildDoctorChecks({ ...healthy, isGitRepo: false, hasTestRunner: false });
    expect(find(checks, "Git repo").level).toBe("warn");
    expect(find(checks, "Test runner").level).toBe("warn");
    expect(hasFatalFailure(checks)).toBe(false); // warnings never block
    expect(find(checks, "Git repo").fix).toContain("git init");
  });

  it("ollama CLI missing → warn with the install link", () => {
    const checks = buildDoctorChecks({ ...healthy, ollamaOnPath: false });
    const cli = find(checks, "Ollama CLI");
    expect(cli.ok).toBe(false);
    expect(cli.level).toBe("warn");
    expect(cli.fix).toContain("ollama.com/download");
  });
});

describe("renderDoctor", () => {
  it("prints ✓/✗ per check and a fix line under failures only", () => {
    const out = renderDoctor(buildDoctorChecks({ ...healthy, serverReachable: false, installedModels: [] }));
    expect(out).toContain("✗ Ollama server:");
    expect(out).toContain("    fix: Start it: ollama serve");
    expect(out).toContain("✓ Config:"); // a passing check has no fix line
    expect(out).toContain("Not ready");
  });
});
