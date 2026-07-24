import { describe, expect, it } from "bun:test";
import {
  classifyCommitFiles,
  type DogfoodResult,
  labelChange,
  summarizeDogfood,
} from "../src/eval/dogfood-history.ts";

/**
 * E3-T3 — dogfood-over-own-history: pure classification/labeling/report helpers.
 * The git-worktree + agent I/O is exercised by the harness itself (setup-only run).
 */
describe("classifyCommitFiles", () => {
  it("splits src (revert) from tests (keep) and ignores docs/config", () => {
    const { src, test, other } = classifyCommitFiles([
      "src/verify/oracle.ts",
      "src/agent/loop.ts",
      "tests/oracle-truncation.test.ts",
      "README.md",
      "docs/architecture.html",
      "bin/smallcode.ts",
    ]);
    expect(src).toEqual(["src/verify/oracle.ts", "src/agent/loop.ts", "bin/smallcode.ts"]);
    expect(test).toEqual(["tests/oracle-truncation.test.ts"]);
    expect(other).toEqual(["README.md", "docs/architecture.html"]);
  });
});

describe("labelChange", () => {
  it("single src file = single-site, multiple = cross-file", () => {
    expect(labelChange(["src/verify/oracle.ts"])).toBe("single-site");
    expect(labelChange(["src/config/env.ts", "src/provider/watchdog.ts"])).toBe("cross-file");
  });
});

describe("summarizeDogfood", () => {
  it("setup-only run reports whether each bug reproduced", () => {
    const r: DogfoodResult[] = [
      { commit: "aaa", label: "single-site", bugReproduced: true },
      { commit: "bbb", label: "cross-file", bugReproduced: true },
      { commit: "ccc", label: "cross-file", bugReproduced: false, skipped: "src reverse-apply failed" },
    ];
    const lines = summarizeDogfood(r);
    expect(lines.some((l) => l.includes("SETUP-OK aaa") && l.includes("bug reproduced: yes"))).toBe(true);
    expect(lines.some((l) => l.includes("SKIP ccc"))).toBe(true);
    expect(lines.some((l) => l.includes("setup-only: 2/2 commits reproduced the bug"))).toBe(true);
  });

  it("agent run reports solved count with model-vs-rescue attribution", () => {
    const r: DogfoodResult[] = [
      { commit: "aaa", label: "single-site", bugReproduced: true, solved: true, rescued: true },
      { commit: "bbb", label: "cross-file", bugReproduced: true, solved: true, rescued: false },
      { commit: "ccc", label: "cross-file", bugReproduced: true, solved: false, rescued: false },
    ];
    const lines = summarizeDogfood(r);
    expect(lines.some((l) => l.includes("PASS aaa") && l.includes("harness-rescued"))).toBe(true);
    expect(lines.some((l) => l.includes("PASS bbb") && l.includes("solved (model)"))).toBe(true);
    expect(lines.some((l) => l.includes("fail ccc"))).toBe(true);
    expect(lines.some((l) => l.includes("solved 2/3") && l.includes("1 model, 1 harness-rescued"))).toBe(true);
  });
});
