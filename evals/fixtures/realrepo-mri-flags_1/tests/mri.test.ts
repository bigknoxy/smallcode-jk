import { test, expect, describe } from "bun:test";
import mri from "../src/index.js";

describe("mri", () => {
  test("consecutive long flags each become true, not consumed as values", () => {
    // Bug: charCodeAt check inverted — next flag-arg is consumed as the value
    // of the preceding flag instead of being parsed as its own flag.
    // Clean: mri(['--foo', '--bar']) => { foo: true, bar: true, _: [] }
    // Buggy: mri(['--foo', '--bar']) => { foo: '--bar', _: [] }
    const out = mri(['--foo', '--bar']);
    expect(out.foo).toBe(true);
    expect(out.bar).toBe(true);
    expect(out._).toEqual([]);
  });

  test("consecutive short flags each become true", () => {
    const out = mri(['-f', '-g']);
    expect(out.f).toBe(true);
    expect(out.g).toBe(true);
    expect(out._).toEqual([]);
  });

  test("flag followed by a plain value consumes that value", () => {
    // Value does NOT start with '-', so it should be consumed.
    const out = mri(['--output', 'dist']);
    expect(out.output).toBe('dist');
    expect(out._).toEqual([]);
  });

  test("flag with = assignment parses correctly", () => {
    const out = mri(['--name=hello']);
    expect(out.name).toBe('hello');
  });

  test("positional args land in _", () => {
    const out = mri(['foo', 'bar']);
    expect(out._).toEqual(['foo', 'bar']);
  });
});
