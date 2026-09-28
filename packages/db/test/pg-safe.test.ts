// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { toPgSafe } from "../src/pg-safe.ts";

const R = "\uFFFD";

describe("toPgSafe", () => {
  it("replaces a NUL in a string value", () => {
    expect(toPgSafe({ text: "a\u0000b" })).toEqual({ text: `a${R}b` });
  });

  it("replaces a NUL in an object key", () => {
    const input: Record<string, number> = { "k\u0000": 1 };
    expect(toPgSafe(input)).toEqual({ [`k${R}`]: 1 });
  });

  it("walks nested arrays and objects", () => {
    const input = { a: [{ b: ["x\u0000", { c: "\u0000" }] }], d: { e: ["ok"] } };
    expect(toPgSafe(input)).toEqual({
      a: [{ b: [`x${R}`, { c: R }] }],
      d: { e: ["ok"] },
    });
  });

  it("replaces a lone high surrogate", () => {
    const out = toPgSafe({ s: "a\uD800b" });
    expect(out).toEqual({ s: `a${R}b` });
    expect(out.s.isWellFormed()).toBe(true);
  });

  it("replaces a lone low surrogate", () => {
    expect(toPgSafe(["\uDC00"])).toEqual([R]);
  });

  it("preserves a valid surrogate pair", () => {
    expect(toPgSafe({ s: "hi \uD83D\uDE00" })).toEqual({ s: "hi 😀" });
  });

  it("returns equal content for clean input", () => {
    const input = { a: "plain", b: [1, "two", { c: "été" }] };
    expect(toPgSafe(input)).toEqual(input);
  });

  it("leaves non-string primitives untouched", () => {
    expect(toPgSafe({ n: 1.5, t: true, f: false, z: null })).toEqual({
      n: 1.5,
      t: true,
      f: false,
      z: null,
    });
    expect(toPgSafe(42)).toBe(42);
    expect(toPgSafe(null)).toBeNull();
  });

  it("sanitises a top-level string", () => {
    expect(toPgSafe("x\u0000\uD800")).toBe(`x${R}${R}`);
  });

  it("does not mutate its input", () => {
    const input = { text: "a\u0000" };
    toPgSafe(input);
    expect(input.text).toBe("a\u0000");
  });

  it("keeps a parsed __proto__ key as data", () => {
    const out = toPgSafe(JSON.parse('{"__proto__": {"x": "\\u0000"}}'));
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
  });

  it("produces JSON free of NUL and lone-surrogate escapes", () => {
    const json = JSON.stringify(toPgSafe({ a: "\u0000\uDFFF\uD800" }));
    expect(json).not.toMatch(/\\u0000|\\ud[89a-f][0-9a-f]{2}/i);
  });

  it("returns non-plain objects unchanged, by reference", () => {
    const date = new Date(0);
    const map = new Map([["k", "\u0000"]]);
    const bytes = new Uint8Array([0]);
    const out = toPgSafe({ date, map, bytes });
    expect(out.date).toBe(date);
    expect(out.map).toBe(map);
    expect(out.bytes).toBe(bytes);
  });

  it("sanitises a null-prototype object", () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, { s: "a\u0000" });
    expect(toPgSafe(input)).toEqual({ s: `a${R}` });
  });
});
