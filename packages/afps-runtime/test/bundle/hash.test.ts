// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { computeIntegrity, verifyIntegrity } from "../../src/bundle/hash.ts";

describe("computeIntegrity", () => {
  it("produces a canonical sha256-<base64> SRI string", () => {
    const sri = computeIntegrity(new TextEncoder().encode("hello"));
    expect(sri).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });

  it("is deterministic for the same input", () => {
    const a = computeIntegrity(new TextEncoder().encode("foo"));
    const b = computeIntegrity(new TextEncoder().encode("foo"));
    expect(a).toBe(b);
  });

  it("differs for different inputs", () => {
    const a = computeIntegrity(new TextEncoder().encode("foo"));
    const b = computeIntegrity(new TextEncoder().encode("bar"));
    expect(a).not.toBe(b);
  });

  it("produces the expected hash for a known vector", () => {
    // sha256("abc") base64 = "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
    const sri = computeIntegrity(new TextEncoder().encode("abc"));
    expect(sri).toBe("sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });

  it("handles empty input", () => {
    const sri = computeIntegrity(new Uint8Array(0));
    expect(sri).toBe("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  });
});

describe("verifyIntegrity", () => {
  const data = new TextEncoder().encode("bundle content");
  const expected = computeIntegrity(data);

  it("returns valid: true when the hash matches", () => {
    const r = verifyIntegrity(data, expected);
    expect(r.valid).toBe(true);
    expect(r.computed).toBe(expected);
  });

  it("returns valid: false when the data was tampered", () => {
    const tampered = new TextEncoder().encode("bundle content tampered");
    const r = verifyIntegrity(tampered, expected);
    expect(r.valid).toBe(false);
    expect(r.computed).not.toBe(expected);
  });

  it("returns valid: false on mismatched hash lengths (safe short-circuit)", () => {
    const r = verifyIntegrity(data, "sha256-short");
    expect(r.valid).toBe(false);
    expect(r.computed).toBe(expected);
  });

  it("returns valid: false when expected string is empty", () => {
    const r = verifyIntegrity(data, "");
    expect(r.valid).toBe(false);
  });
});
