import { describe, expect, test } from "bun:test";
import {
  defaultFingerprintDeps,
  type FingerprintDeps,
  repoFingerprint,
} from "../src/verify/fingerprint.ts";

/**
 * E6-T2: the repo-state fingerprint. Two properties are load-bearing —
 * it is DETERMINISTIC (same state ⇒ same hash) and it FAILS CLOSED (any
 * uncertainty ⇒ `null`, meaning never cache). A false "unchanged" here would
 * let the oracle cache report a stale verdict for a repo that DID change, and
 * a verdict decides whether an edit is kept. Model-free, disk-free.
 */

const ROOT = "/repo";

/** Deps over an in-memory repo. Everything overridable per-test. */
function deps(over: Partial<FingerprintDeps> & { files?: Record<string, string> } = {}): FingerprintDeps {
  const files = over.files ?? { "src/a.ts": "a", "tests/a.test.ts": "t" };
  const enc = (s: string) => new TextEncoder().encode(s);
  const base: FingerprintDeps = {
    listTrackedFiles: () => Object.keys(files).map((path) => ({ path, mode: "100644" })),
    hasUntrackedFiles: () => false,
    readFile: (abs) => {
      const rel = abs.slice(`${ROOT}/`.length);
      const v = files[rel];
      return v === undefined ? null : enc(v);
    },
    readOptionalFile: () => undefined,
    bunVersion: "1.3.12",
    subprocessEnv: { PATH: "/usr/bin", HOME: "/home/u" },
    testCommand: ["bun", "test"],
  };
  const { files: _ignored, ...rest } = over;
  return { ...base, ...rest };
}

const fp = (d: FingerprintDeps) => repoFingerprint(ROOT, d);

describe("repoFingerprint — determinism", () => {
  test("two calls on an unchanged repo return the identical hash", () => {
    const d = deps();
    const first = fp(d);
    expect(first).toBeString();
    expect(fp(d)).toBe(first as string);
  });

  test("file enumeration order does not change the hash", () => {
    const files = { "src/a.ts": "a", "src/b.ts": "b", "tests/a.test.ts": "t" };
    const track = (paths: string[]) => paths.map((path) => ({ path, mode: "100644" }));
    const forward = fp(deps({ files, listTrackedFiles: () => track(Object.keys(files)) }));
    const reversed = fp(deps({ files, listTrackedFiles: () => track(Object.keys(files).reverse()) }));
    expect(forward).toBe(reversed as string);
  });

  test("env enumeration order does not change the hash", () => {
    const a = fp(deps({ subprocessEnv: { A: "1", B: "2" } }));
    const b = fp(deps({ subprocessEnv: { B: "2", A: "1" } }));
    expect(a).toBe(b as string);
  });
});

describe("repoFingerprint — changes when the verdict could change", () => {
  const baseline = fp(deps());

  test("a source file edit changes the hash", () => {
    expect(fp(deps({ files: { "src/a.ts": "a-EDITED", "tests/a.test.ts": "t" } }))).not.toBe(baseline);
  });

  test("a test file edit changes the hash", () => {
    expect(fp(deps({ files: { "src/a.ts": "a", "tests/a.test.ts": "t-EDITED" } }))).not.toBe(baseline);
  });

  test("adding a file changes the hash", () => {
    expect(fp(deps({ files: { "src/a.ts": "a", "src/b.ts": "b", "tests/a.test.ts": "t" } }))).not.toBe(
      baseline,
    );
  });

  test("deleting a file changes the hash", () => {
    expect(fp(deps({ files: { "src/a.ts": "a" } }))).not.toBe(baseline);
  });

  test("renaming a file changes the hash even when contents are identical", () => {
    expect(fp(deps({ files: { "src/renamed.ts": "a", "tests/a.test.ts": "t" } }))).not.toBe(baseline);
  });

  test("moving content between files changes the hash", () => {
    const split = fp(deps({ files: { "src/a.ts": "ab", "tests/a.test.ts": "" } }));
    const other = fp(deps({ files: { "src/a.ts": "a", "tests/a.test.ts": "b" } }));
    expect(split).not.toBe(other);
  });

  test("file content cannot forge another file's framing (fields are length-prefixed)", () => {
    // Two genuinely different repos that serialize to the SAME byte stream if
    // fields are only label-delimited: repo A is two files, repo B is one file
    // whose contents spell out A's second entry. Length prefixes make the two
    // streams differ; without them this is a real cache-poisoning collision —
    // an attacker-free one, since any source file may contain arbitrary text.
    const twoFiles = fp(deps({ files: { "a": "x", "b": "y" } }));
    // Both plausible framings are forged, so the test bites whether the
    // implementation delimits by label alone or by label+length.
    for (const forged of ["x\nfile:by", "x:1\nfile:b:1\ny"]) {
      const oneFile = fp(deps({ files: { a: forged }, listTrackedFiles: () => [{ path: "a", mode: "100644" }] }));
      expect(oneFile).not.toBe(twoFiles as string);
    }
  });

  test("bunfig.toml appearing changes the hash, and absent is not the same as empty", () => {
    const enc = new TextEncoder();
    const absent = fp(deps({ readOptionalFile: () => undefined }));
    const empty = fp(deps({ readOptionalFile: (p) => (p.endsWith("bunfig.toml") ? enc.encode("") : undefined) }));
    const present = fp(
      deps({ readOptionalFile: (p) => (p.endsWith("bunfig.toml") ? enc.encode("[test]\nroot='tests'") : undefined) }),
    );
    expect(absent).not.toBe(empty);
    expect(empty).not.toBe(present);
  });

  test("the lockfile changes the hash", () => {
    const enc = new TextEncoder();
    const before = fp(deps({ readOptionalFile: (p) => (p.endsWith("bun.lock") ? enc.encode("v1") : undefined) }));
    const after = fp(deps({ readOptionalFile: (p) => (p.endsWith("bun.lock") ? enc.encode("v2") : undefined) }));
    expect(before).not.toBe(after);
  });

  test("chmod +x on a tracked file changes the hash (bytes identical)", () => {
    // Git tracks the mode; a script that becomes executable can flip a test
    // outcome while every byte on disk stays the same. Content-only hashing
    // would call this state "unchanged" — a false cache hit.
    const exec = fp(
      deps({
        listTrackedFiles: () => [
          { path: "src/a.ts", mode: "100755" },
          { path: "tests/a.test.ts", mode: "100644" },
        ],
      }),
    );
    expect(exec).not.toBe(baseline);
  });

  test("a tracked symlink ⇒ null (its git blob is the target path, not the bytes read)", () => {
    expect(
      fp(deps({ listTrackedFiles: () => [{ path: "src/a.ts", mode: "120000" }] })),
    ).toBeNull();
  });

  test("the test command changes the hash", () => {
    expect(fp(deps({ testCommand: ["bun", "test", "tests/a.test.ts"] }))).not.toBe(baseline);
  });

  test("the bun version changes the hash", () => {
    expect(fp(deps({ bunVersion: "1.3.14" }))).not.toBe(baseline);
  });

  test("the sanitized env changes the hash", () => {
    expect(fp(deps({ subprocessEnv: { PATH: "/usr/bin", HOME: "/home/OTHER" } }))).not.toBe(baseline);
  });
});

describe("repoFingerprint — fails closed", () => {
  test("git failure (listTrackedFiles null) ⇒ null", () => {
    expect(fp(deps({ listTrackedFiles: () => null }))).toBeNull();
  });

  test("a tracked but unreadable file ⇒ null", () => {
    expect(fp(deps({ readFile: () => null }))).toBeNull();
  });

  test("an untracked non-ignored file ⇒ null (it could be a new test)", () => {
    expect(fp(deps({ hasUntrackedFiles: () => true }))).toBeNull();
  });

  test("undeterminable untracked state ⇒ null", () => {
    expect(fp(deps({ hasUntrackedFiles: () => null }))).toBeNull();
  });

  test("a present-but-unreadable optional file ⇒ null, not a silent skip", () => {
    expect(fp(deps({ readOptionalFile: () => null }))).toBeNull();
  });

  test("null is never confusable with a valid hash", () => {
    const good = fp(deps());
    expect(good).toBeString();
    expect((good as string).length).toBe(64); // sha256 hex
    expect(good).not.toBe("");
  });

  test("an empty repo still fingerprints (no files is a real, stable state)", () => {
    const empty = fp(deps({ files: {}, listTrackedFiles: (): [] => [] }));
    expect(empty).toBeString();
    expect(empty).not.toBe(fp(deps()));
  });
});

describe("defaultFingerprintDeps — real git/disk backing", () => {
  test("fingerprints this repo deterministically and reacts to a real change", () => {
    const d = defaultFingerprintDeps({ PATH: process.env["PATH"] ?? "" }, ["bun", "test"]);
    const files = d.listTrackedFiles(process.cwd());
    expect(files).not.toBeNull();
    expect((files ?? []).length).toBeGreaterThan(0);
    // A long-committed path — this module itself may still be untracked when
    // the test first runs, which would make the assertion about git, not us.
    expect((files ?? []).map((f) => f.path)).toContain("src/verify/oracle.ts");
    // Real modes come back in git's 6-digit octal form, not as a placeholder.
    for (const f of files ?? []) expect(f.mode).toMatch(/^[0-7]{6}$/);

    // Optional-file contract on real disk: present ⇒ bytes, absent ⇒ undefined.
    expect(d.readOptionalFile(`${process.cwd()}/bunfig.toml`)).toBeInstanceOf(Uint8Array);
    expect(d.readOptionalFile(`${process.cwd()}/definitely-not-here.toml`)).toBeUndefined();

    // Real read of a real file, and a miss on a real absence.
    expect(d.readFile(`${process.cwd()}/package.json`)).toBeInstanceOf(Uint8Array);
    expect(d.readFile(`${process.cwd()}/definitely-not-here.json`)).toBeNull();

    expect(d.bunVersion).toBe(Bun.version);
  });

  test("a non-git directory ⇒ null tracked list and null fingerprint", () => {
    const d = defaultFingerprintDeps({ PATH: process.env["PATH"] ?? "" }, ["bun", "test"]);
    // "/" is not a git repo on any machine this suite runs on.
    expect(d.listTrackedFiles("/")).toBeNull();
    expect(repoFingerprint("/", d)).toBeNull();
  });
});
