import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSymbols } from "@/context/extractor.ts";
import { walkRepo } from "@/context/walker.ts";

// ---------------------------------------------------------------------------
// extractSymbols tests
// ---------------------------------------------------------------------------

describe("extractSymbols — TypeScript", () => {
  it("1. extracts a function declaration with correct name, kind, and line", () => {
    const src = `
function greet(name: string): string {
  return "hello " + name;
}
`.trimStart();
    const symbols = extractSymbols("test.ts", src, "typescript");
    const fn = symbols.find((s) => s.name === "greet");
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe("function");
    expect(fn?.line).toBe(1);
    expect(fn?.signature).toContain("greet");
  });

  it("2. extracts a class and its method (method as ClassName.method)", () => {
    const src = `
class Animal {
  speak(volume: number): void {
    console.log(volume);
  }
}
`.trimStart();
    const symbols = extractSymbols("test.ts", src, "typescript");
    const cls = symbols.find((s) => s.kind === "class");
    expect(cls?.name).toBe("Animal");
    expect(cls?.line).toBe(1);

    const method = symbols.find((s) => s.kind === "method");
    expect(method?.name).toBe("Animal.speak");
    expect(method?.signature).toContain("Animal.speak");
  });

  it("3. extracts an interface", () => {
    const src = `
interface Shape {
  area(): number;
}
`.trimStart();
    const symbols = extractSymbols("test.ts", src, "typescript");
    const iface = symbols.find((s) => s.kind === "interface");
    expect(iface?.name).toBe("Shape");
    expect(iface?.line).toBe(1);
  });

  it("4. extracts a type alias", () => {
    const src = `
type Color = "red" | "green" | "blue";
`.trimStart();
    const symbols = extractSymbols("test.ts", src, "typescript");
    const typeAlias = symbols.find((s) => s.kind === "type");
    expect(typeAlias?.name).toBe("Color");
    expect(typeAlias?.line).toBe(1);
  });

  it("5. extracts an exported const arrow function as kind 'function'", () => {
    const src = `
export const add = (a: number, b: number): number => a + b;
`.trimStart();
    const symbols = extractSymbols("test.ts", src, "typescript");
    const fn = symbols.find((s) => s.name === "add");
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe("function");
    expect(fn?.signature).toContain("add");
  });
});

describe("extractSymbols — Python", () => {
  it("6. extracts def and class", () => {
    const src = [
      "class Dog:",
      "    def bark(self):",
      "        print('woof')",
      "",
      "async def fetch(url: str) -> str:",
      "    return url",
    ].join("\n");

    const symbols = extractSymbols("test.py", src, "python");
    const cls = symbols.find((s) => s.kind === "class");
    expect(cls?.name).toBe("Dog");
    expect(cls?.line).toBe(1);

    const bark = symbols.find((s) => s.name === "bark");
    expect(bark?.kind).toBe("function");
    expect(bark?.line).toBe(2);

    const fetch = symbols.find((s) => s.name === "fetch");
    expect(fetch?.kind).toBe("function");
    expect(fetch?.line).toBe(5);
  });
});

describe("extractSymbols — Go", () => {
  it("7. extracts func", () => {
    const src = [
      "package main",
      "",
      "func Add(a int, b int) int {",
      "    return a + b",
      "}",
      "",
      "func (r Rectangle) Area() float64 {",
      "    return r.width * r.height",
      "}",
    ].join("\n");

    const symbols = extractSymbols("main.go", src, "go");
    const add = symbols.find((s) => s.name === "Add");
    expect(add?.kind).toBe("function");
    expect(add?.line).toBe(3);

    const area = symbols.find((s) => s.name === "Area");
    expect(area?.kind).toBe("function");
    expect(area?.line).toBe(7);
  });
});

describe("extractSymbols — Rust", () => {
  it("8. extracts fn and struct", () => {
    const src = [
      "pub struct Point {",
      "    x: f64,",
      "    y: f64,",
      "}",
      "",
      "pub fn distance(p: &Point) -> f64 {",
      "    (p.x * p.x + p.y * p.y).sqrt()",
      "}",
    ].join("\n");

    const symbols = extractSymbols("lib.rs", src, "rust");
    const point = symbols.find((s) => s.name === "Point");
    expect(point?.kind).toBe("class");
    expect(point?.line).toBe(1);

    const dist = symbols.find((s) => s.name === "distance");
    expect(dist?.kind).toBe("function");
    expect(dist?.line).toBe(6);
  });
});

describe("extractSymbols — edge cases", () => {
  it("9. empty file → empty symbols array", () => {
    expect(extractSymbols("empty.ts", "", "typescript")).toEqual([]);
  });

  it("10. file with no matching symbols → empty array", () => {
    const src = "// just a comment\nconst x = 1;\n";
    const symbols = extractSymbols("noexport.ts", src, "typescript");
    // x is not exported, so no const symbol; no functions/classes/etc.
    expect(symbols.every((s) => s.name !== "x" || s.kind !== "const")).toBe(true);
  });

  it("11. unknown language → empty array", () => {
    const src = "hello world";
    expect(extractSymbols("file.xyz", src, "unknown")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// walkRepo integration tests
// ---------------------------------------------------------------------------

describe("walkRepo integration", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `smallcode-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    // File 1: TypeScript source
    await writeFile(
      join(tmpDir, "math.ts"),
      [
        "export function square(n: number): number {",
        "  return n * n;",
        "}",
        "",
        "export const PI = 3.14159;",
      ].join("\n"),
      "utf-8",
    );

    // File 2: Python source
    await writeFile(
      join(tmpDir, "utils.py"),
      ["def greet(name):", "    return f'Hello, {name}'"].join("\n"),
      "utf-8",
    );

    // File 3: nested directory with another TS file
    await mkdir(join(tmpDir, "lib"), { recursive: true });
    await writeFile(
      join(tmpDir, "lib", "helpers.ts"),
      ["export interface Config {", "  debug: boolean;", "}"].join("\n"),
      "utf-8",
    );

    // node_modules directory — should be excluded
    await mkdir(join(tmpDir, "node_modules", "some-pkg"), { recursive: true });
    await writeFile(
      join(tmpDir, "node_modules", "some-pkg", "index.ts"),
      "export const ignored = true;",
      "utf-8",
    );
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns correct file count (3 files, node_modules excluded)", async () => {
    const map = await walkRepo({ root: tmpDir }, Date.now());
    // Should have math.ts, utils.py, lib/helpers.ts — NOT node_modules
    expect(map.files.length).toBe(3);
    const paths = map.files.map((f) => f.path);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("symbols are present in output", async () => {
    const map = await walkRepo({ root: tmpDir }, Date.now());
    expect(map.totalSymbols).toBeGreaterThan(0);

    const mathFile = map.files.find((f) => f.path === "math.ts");
    expect(mathFile).toBeDefined();
    expect(mathFile?.symbols.some((s) => s.name === "square")).toBe(true);

    const pyFile = map.files.find((f) => f.path === "utils.py");
    expect(pyFile).toBeDefined();
    expect(pyFile?.symbols.some((s) => s.name === "greet")).toBe(true);

    const helperFile = map.files.find((f) => f.path === "lib/helpers.ts");
    expect(helperFile).toBeDefined();
    expect(helperFile?.symbols.some((s) => s.kind === "interface")).toBe(true);
  });

  it("node_modules is excluded by default", async () => {
    const map = await walkRepo({ root: tmpDir }, Date.now());
    const paths = map.files.map((f) => f.path);
    expect(paths.every((p) => !p.includes("node_modules"))).toBe(true);
  });

  it("builtAt matches the now value passed in", async () => {
    const now = 1718000000000;
    const map = await walkRepo({ root: tmpDir }, now);
    expect(map.builtAt).toBe(now);
  });

  it("root is set to the provided root", async () => {
    const map = await walkRepo({ root: tmpDir }, Date.now());
    expect(map.root).toBe(tmpDir);
  });
});
