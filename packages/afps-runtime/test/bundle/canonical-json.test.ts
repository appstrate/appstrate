// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { canonicalJsonStringify } from "../../src/bundle/canonical-json.ts";

describe("canonicalJsonStringify", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
  });

  it("is insensitive to insertion order", () => {
    const a = canonicalJsonStringify({ a: 1, b: 2, c: 3 });
    const b = canonicalJsonStringify({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("recurses into nested objects", () => {
    expect(canonicalJsonStringify({ x: { z: 1, a: 2 } })).toBe(`{"x":{"a":2,"z":1}}`);
  });

  it("preserves array order", () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe(`[3,1,2]`);
  });

  it("omits undefined values", () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe(`{"a":1}`);
  });

  it("serializes null, booleans, numbers, strings", () => {
    expect(canonicalJsonStringify(null)).toBe("null");
    expect(canonicalJsonStringify(true)).toBe("true");
    expect(canonicalJsonStringify(false)).toBe("false");
    expect(canonicalJsonStringify(42)).toBe("42");
    expect(canonicalJsonStringify("hello")).toBe(`"hello"`);
    expect(canonicalJsonStringify('say "hi"')).toBe(`"say \\"hi\\""`);
  });

  it("throws on NaN / Infinity", () => {
    expect(() => canonicalJsonStringify(NaN)).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify(Infinity)).toThrow(/non-finite/);
  });

  it("throws on functions", () => {
    expect(() => canonicalJsonStringify(() => 42)).toThrow(/cannot canonicalize/);
  });

  it("handles non-ASCII keys with code-point ordering", () => {
    // 'b' (0x62) < 'é' (0xe9)
    expect(canonicalJsonStringify({ é: 1, b: 2 })).toBe(`{"b":2,"é":1}`);
  });
});
