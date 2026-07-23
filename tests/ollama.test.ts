import { describe, expect, it } from "bun:test";
import {
  type FetchFn,
  listOllamaModels,
  modelIsPulled,
  ollamaNativeBase,
  pingOllama,
  pullOllamaModel,
} from "../src/models/ollama.ts";

function fakeFetch(handler: (url: string) => { ok: boolean; status: number; body?: unknown }): FetchFn {
  return async (url) => {
    const r = handler(url);
    return { ok: r.ok, status: r.status, json: async () => r.body ?? {} };
  };
}

describe("ollamaNativeBase", () => {
  it("strips a trailing /v1 to reach the native API root", () => {
    expect(ollamaNativeBase("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(ollamaNativeBase("http://localhost:11434/v1/")).toBe("http://localhost:11434");
    expect(ollamaNativeBase("http://host:1234")).toBe("http://host:1234"); // no /v1 → unchanged
  });
});

describe("modelIsPulled", () => {
  const installed = ["qwen2.5-coder:3b", "qwen2.5-coder:7b", "nomic-embed-text:latest"];
  it("matches a tagged id exactly", () => {
    expect(modelIsPulled(installed, "qwen2.5-coder:3b")).toBe(true);
    expect(modelIsPulled(installed, "qwen2.5-coder:32b")).toBe(false);
  });
  it("a bare id matches :latest", () => {
    expect(modelIsPulled(installed, "nomic-embed-text")).toBe(true);
    expect(modelIsPulled(installed, "missing-model")).toBe(false);
  });
  it("a tagged id does NOT loosely match a different tag", () => {
    expect(modelIsPulled(["qwen2.5-coder:7b"], "qwen2.5-coder:3b")).toBe(false);
  });
});

describe("pingOllama", () => {
  it("ok when /api/tags returns 200 (and hits the native root, not /v1)", async () => {
    let hit = "";
    const fetchFn = fakeFetch((url) => {
      hit = url;
      return { ok: true, status: 200, body: { models: [] } };
    });
    const res = await pingOllama("http://localhost:11434/v1", { fetchFn });
    expect(res.ok).toBe(true);
    expect(hit).toBe("http://localhost:11434/api/tags");
  });

  it("not ok with the HTTP status on a non-200", async () => {
    const fetchFn = fakeFetch(() => ({ ok: false, status: 500 }));
    const res = await pingOllama("http://localhost:11434/v1", { fetchFn });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("HTTP 500");
  });

  it("not ok with a connection error message when fetch throws", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    };
    const res = await pingOllama("http://localhost:11434/v1", { fetchFn });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("reports a timeout when the request aborts", async () => {
    const fetchFn: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
      });
    const res = await pingOllama("http://localhost:11434/v1", { fetchFn, timeoutMs: 20 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("20ms");
  });
});

describe("listOllamaModels", () => {
  it("returns the model names from /api/tags", async () => {
    const fetchFn = fakeFetch(() => ({
      ok: true,
      status: 200,
      body: { models: [{ name: "qwen2.5-coder:3b" }, { name: "gemma4:12b" }] },
    }));
    expect(await listOllamaModels("http://localhost:11434/v1", { fetchFn })).toEqual([
      "qwen2.5-coder:3b",
      "gemma4:12b",
    ]);
  });
  it("returns [] on error (server down) — never throws", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("down");
    };
    expect(await listOllamaModels("http://localhost:11434/v1", { fetchFn })).toEqual([]);
  });
});

describe("pullOllamaModel", () => {
  it("ok when `ollama pull` exits 0; passes the right command", async () => {
    let cmd: string[] = [];
    const res = await pullOllamaModel("qwen2.5-coder:3b", {
      runner: async (c) => {
        cmd = c;
        return { exitCode: 0 };
      },
    });
    expect(res.ok).toBe(true);
    expect(cmd).toEqual(["ollama", "pull", "qwen2.5-coder:3b"]);
  });
  it("not ok with the exit code on a non-zero pull", async () => {
    const res = await pullOllamaModel("bad-model", { runner: async () => ({ exitCode: 1 }) });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("exited 1");
  });
  it("not ok when the runner throws (ollama not on PATH)", async () => {
    const res = await pullOllamaModel("x", {
      runner: async () => {
        throw new Error("ollama: command not found");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("command not found");
  });
});
