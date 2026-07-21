// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the leaf preview primitives — token HMAC (sign/verify, expiry,
 * cross-type domain separation) and the meta-CSP injection transform.
 */

import { describe, it, expect } from "bun:test";
import {
  signPreviewToken,
  verifyPreviewToken,
  buildPreviewCsp,
  injectMetaCsp,
  isHtmlMime,
} from "../../../src/services/document-preview.ts";
import { signFsUploadToken } from "@appstrate/core/storage-fs";

const SECRET = "unit-preview-secret-key-0123456789";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe("preview token", () => {
  it("round-trips a valid, unexpired token", () => {
    const token = signPreviewToken({ d: "doc_abc12345", o: "org_1", e: nowSec() + 60 }, SECRET);
    const payload = verifyPreviewToken(token, SECRET);
    expect(payload).toEqual({ d: "doc_abc12345", o: "org_1", e: expect.any(Number) });
  });

  it("rejects an expired token", () => {
    const token = signPreviewToken({ d: "doc_abc12345", o: "org_1", e: nowSec() - 1 }, SECRET);
    expect(verifyPreviewToken(token, SECRET)).toBeNull();
  });

  it("rejects a tampered signature and a wrong secret", () => {
    const token = signPreviewToken({ d: "doc_abc12345", o: "org_1", e: nowSec() + 60 }, SECRET);
    expect(verifyPreviewToken(token + "x", SECRET)).toBeNull();
    expect(verifyPreviewToken(token, "a-different-secret-key-abcdefgh")).toBeNull();
  });

  it("verifies against every key in a rotation keyring", () => {
    const oldKey = "old-preview-secret-key-000000000";
    const newKey = "new-preview-secret-key-111111111";
    const signedWithOld = signPreviewToken({ d: "doc_x1234567", o: "o", e: nowSec() + 60 }, oldKey);
    // Keyring [new, old]: new signs, both verify — an in-flight old token stays valid.
    expect(verifyPreviewToken(signedWithOld, [newKey, oldKey])).not.toBeNull();
  });

  it("does not accept an upload token as a preview token (domain separation)", () => {
    // An upload token shares the same secret but a different HMAC domain — it
    // must never validate as a preview capability.
    const uploadToken = signFsUploadToken(
      { k: "documents/x", s: 0, m: "", e: nowSec() + 60 },
      SECRET,
    );
    expect(verifyPreviewToken(uploadToken, SECRET)).toBeNull();
  });
});

describe("buildPreviewCsp", () => {
  it("denies by default and pins frame-ancestors to the app origin", () => {
    const csp = buildPreviewCsp("https://app.example");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors https://app.example");
  });
});

describe("injectMetaCsp", () => {
  const csp = "default-src 'none'";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;

  it("injects as the first child of an existing <head>", () => {
    const out = injectMetaCsp("<!doctype html><html><head><title>t</title></head>", csp);
    expect(out).toContain(`<head>${meta}<title>`);
  });

  it("creates a <head> when only <html> is present", () => {
    const out = injectMetaCsp("<html><body>x</body></html>", csp);
    expect(out).toContain(`<html><head>${meta}</head>`);
  });

  it("creates a <head> after the doctype when neither <html> nor <head> exists", () => {
    const out = injectMetaCsp("<!doctype html><p>x</p>", csp);
    expect(out).toContain(`<!doctype html><head>${meta}</head>`);
  });

  it("prepends a <head> for a bare fragment", () => {
    const out = injectMetaCsp("<p>x</p>", csp);
    expect(out).toBe(`<head>${meta}</head><p>x</p>`);
  });
});

describe("isHtmlMime", () => {
  it("matches text/html with or without parameters", () => {
    expect(isHtmlMime("text/html")).toBe(true);
    expect(isHtmlMime("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlMime("TEXT/HTML")).toBe(true);
  });
  it("rejects non-HTML mimes", () => {
    expect(isHtmlMime("application/pdf")).toBe(false);
    expect(isHtmlMime("image/png")).toBe(false);
    expect(isHtmlMime("text/plain")).toBe(false);
  });
});
