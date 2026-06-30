import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStaticConfidence, renderConfidence } from "../src/verify/confidence.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "conf-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return dir;
}

describe("static-confidence ladder (oracle-free)", () => {
  test("a parsing source file with no tsconfig → 'parses'", async () => {
    const dir = await repo({ "src/a.ts": "export const add = (a: number, b: number) => a + b;\n" });
    const c = await computeStaticConfidence(dir, undefined);
    expect(c.level).toBe("parses");
    expect(c.signals.some((s) => s.includes("NOT correctness-verified"))).toBe(true);
  });

  test("a structural parse break → 'broken' (caught without any test/tsconfig)", async () => {
    const dir = await repo({ "src/a.ts": "export const x = (() => { return ; ;;; @@@ }\n" });
    const c = await computeStaticConfidence(dir, undefined);
    expect(c.level).toBe("broken");
    expect(c.signals.some((s) => s.startsWith("parse error in"))).toBe(true);
  });

  test("WRONG LOGIC still parses → 'parses' (the honest limitation: static can't see it)", async () => {
    const dir = await repo({ "src/a.ts": "export const add = (a: number, b: number) => a - b; // bug\n" });
    const c = await computeStaticConfidence(dir, undefined);
    expect(c.level).toBe("parses"); // same grade as a correct version — by design
  });

  test("typecheck passed → 'type-clean' (stronger than parse-only)", async () => {
    const dir = await repo({ "src/a.ts": "export const ok = 1;\n" });
    const c = await computeStaticConfidence(dir, {
      kind: "typecheck",
      name: "tsc",
      status: "passed",
      output: "",
      durationMs: 1,
      exitCode: 0,
    });
    expect(c.level).toBe("type-clean");
    expect(c.signals).toContain("typescript: no errors");
  });

  test("no source files → 'unknown'", async () => {
    const dir = await repo({ "README.md": "hi\n" });
    const c = await computeStaticConfidence(dir, undefined);
    expect(c.level).toBe("unknown");
  });

  test("renderConfidence is a one-line honest summary", async () => {
    const s = renderConfidence({ level: "parses", signals: ["a", "b"] });
    expect(s).toBe("Static confidence: parses (a; b)");
  });
});
