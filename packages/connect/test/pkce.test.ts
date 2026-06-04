// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { randomBase64Url, sha256Base64Url } from "../src/pkce.ts";

describe("sha256Base64Url", () => {
  it("matches the RFC 7636 Appendix B S256 test vector", () => {
    // RFC 7636 Appendix B: verifier → SHA-256 → base64url(no padding) → challenge.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(sha256Base64Url(verifier)).toBe(expectedChallenge);
  });

  it("produces a 43-char URL-safe digest with no padding", () => {
    const out = sha256Base64Url("anything");
    expect(out).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("randomBase64Url", () => {
  it("produces URL-safe output with no '+', '/', or '=' characters", () => {
    for (const n of [1, 16, 32, 64]) {
      const out = randomBase64Url(n);
      expect(out).not.toContain("+");
      expect(out).not.toContain("/");
      expect(out).not.toContain("=");
      expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("produces the base64url length expected for the given byte count", () => {
    // base64url(no padding) encodes n bytes in ceil(n * 4 / 3) chars.
    for (const n of [16, 24, 32, 48]) {
      const expectedLength = Math.ceil((n * 4) / 3);
      expect(randomBase64Url(n).length).toBe(expectedLength);
    }
  });

  it("is non-deterministic across calls", () => {
    expect(randomBase64Url(32)).not.toBe(randomBase64Url(32));
  });
});
