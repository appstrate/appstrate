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
  buildInertPreviewCsp,
  injectMetaCsp,
  isHtmlMime,
  previewKind,
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

describe("previewKind", () => {
  it("classifies html", () => {
    expect(previewKind("text/html")).toBe("html");
    expect(previewKind("text/html; charset=utf-8")).toBe("html");
    expect(previewKind("TEXT/HTML")).toBe("html");
  });

  it("classifies the allowlisted raster image mimes", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(previewKind(mime)).toBe("image");
    }
  });

  it("classifies pdf", () => {
    expect(previewKind("application/pdf")).toBe("pdf");
  });

  it("classifies the conservative text allowlist as text", () => {
    for (const mime of ["text/plain", "text/markdown", "text/csv", "application/json"]) {
      expect(previewKind(mime)).toBe("text");
    }
    expect(previewKind("text/markdown; charset=utf-8")).toBe("text");
  });

  it("excludes SVG (active content) — not previewable", () => {
    // SVG is scriptable, so it is deliberately NOT routed through the inert
    // image path; it is downloadable but not previewable.
    expect(previewKind("image/svg+xml")).toBeNull();
  });

  it("returns null for non-allowlisted mimes (no text/* blanket, no octet-stream)", () => {
    expect(previewKind("application/octet-stream")).toBeNull();
    expect(previewKind("application/xml")).toBeNull();
    expect(previewKind("text/xml")).toBeNull();
    expect(previewKind("image/svg+xml")).toBeNull();
    expect(previewKind("video/mp4")).toBeNull();
  });
});

describe("buildInertPreviewCsp", () => {
  it("denies everything and pins frame-ancestors to the app origin", () => {
    const csp = buildInertPreviewCsp("https://app.example");
    expect(csp).toBe("default-src 'none'; frame-ancestors https://app.example");
  });
});
