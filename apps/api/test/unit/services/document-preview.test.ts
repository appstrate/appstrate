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
  mayServeActiveHtml,
} from "../../../src/services/document-preview.ts";
import { signFsUploadToken, verifyFsUploadToken } from "@appstrate/core/storage-fs";

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

  it("domain separation holds in BOTH directions against upload tokens", () => {
    // Upload tokens and preview tokens share the `UPLOAD_SIGNING_SECRET`
    // keyring, so the only thing keeping one from being replayed as the other
    // is the HMAC domain each is signed under. Both types now carry one (the
    // shared codec takes it as a required argument), so neither direction
    // validates — previously only the preview side was bound, and the upload
    // side was protected by nothing more than its payload shape.
    const uploadToken = signFsUploadToken(
      { k: "documents/x", s: 0, m: "", e: nowSec() + 60 },
      SECRET,
    );
    expect(verifyPreviewToken(uploadToken, SECRET)).toBeNull();

    // Deliberately give the preview token an UPLOAD-shaped payload too, so the
    // rejection can only come from the domain-separated signature — not from a
    // missing field the upload verifier happens to check.
    const previewToken = signPreviewToken(
      { d: "doc_abc12345", o: "org_1", e: nowSec() + 60, k: "documents/x", s: 0, m: "" } as never,
      SECRET,
    );
    expect(verifyFsUploadToken(previewToken, SECRET)).toBeNull();
  });
});

describe("buildPreviewCsp", () => {
  it("denies by default and pins frame-ancestors to the app origin", () => {
    const csp = buildPreviewCsp("https://app.example");
    for (const copy of [csp.header, csp.meta]) {
      expect(copy).toContain("default-src 'none'");
      expect(copy).toContain("connect-src 'none'");
      expect(copy).toContain("form-action 'none'");
      expect(copy).toContain("base-uri 'none'");
      expect(copy).toContain("frame-ancestors https://app.example");
    }
  });

  it("sandboxes the header copy into an opaque origin", () => {
    // The directive that stops agent script from navigating the top-level
    // browsing context to a real `/login` (GHSA-8f6g-r37m-wg99).
    expect(buildPreviewCsp("https://app.example").header).toContain("sandbox allow-scripts");
  });

  it("grants no sandbox token beyond allow-scripts", () => {
    const { header } = buildPreviewCsp("https://app.example");
    // `allow-same-origin` would hand the document back a real origin; a popup
    // to the app's `/login` reopens the phishing chain the sandbox closes.
    expect(header).not.toContain("allow-same-origin");
    expect(header).not.toContain("allow-popups");
    // `allow-top-navigation` is a prefix of `allow-top-navigation-by-user-activation`,
    // so this single assertion rejects both variants.
    expect(header).not.toContain("allow-top-navigation");
  });

  it("keeps sandbox OUT of the meta copy (ignored in a meta context)", () => {
    expect(buildPreviewCsp("https://app.example").meta).not.toContain("sandbox");
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

describe("mayServeActiveHtml", () => {
  it("is active ONLY for a proven nested-document load", () => {
    expect(mayServeActiveHtml("iframe")).toBe(true);
  });

  it("fails closed on a top-level navigation, a bare fetch, and a missing header", () => {
    // `document` is the shared-link / new-tab case the whole gate exists for: a
    // top-level agent document can navigate ITSELF (the sandbox flags only gate
    // navigating an ancestor), so it can be a fake login form that carries the
    // typed-in credentials out in a navigation URL. Refusing the render is the
    // only control over that channel.
    for (const dest of ["document", "empty", "object", "embed", "frame", "", null, "IFRAME"]) {
      expect(mayServeActiveHtml(dest)).toBe(false);
    }
  });

  it("takes the loading context as its ONLY input — no separate-origin escape hatch", () => {
    // Regression guard. The function used to take `{ separateOrigin,
    // secFetchDest }` and short-circuit to `true` whenever USERCONTENT_URL was
    // set — which is what let agent HTML render as an active TOP-LEVEL
    // document, the render this branch removes. Reintroducing any second input
    // breaks this suite twice over: the signature change makes every call above
    // a compile error, and at runtime an ignored `"iframe"` string yields
    // `false`. Nothing but the header value may flip the answer, so passing one
    // alongside a would-be separate-origin flag changes nothing.
    const extra = mayServeActiveHtml as (d: string | null, ...rest: unknown[]) => boolean;
    expect(extra("document", { separateOrigin: true })).toBe(false);
    expect(extra("iframe", { separateOrigin: false })).toBe(true);
  });
});
