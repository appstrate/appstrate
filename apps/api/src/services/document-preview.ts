// SPDX-License-Identifier: Apache-2.0

/**
 * Preview-token + HTML-hardening primitives for the cookie-less document
 * preview route (Phase 4 / D5).
 *
 * Agent-generated HTML is untrusted code that runs in the user's browser. The
 * platform serves it from a hardened, session-less route authorized ONLY by a
 * short-lived signed token carried in the URL — never by a cookie. This module
 * holds the leaf-level primitives (no DB, no HTTP) so they stay unit-testable in
 * isolation:
 *
 *  - {@link signPreviewToken} / {@link verifyPreviewToken} — HMAC capability
 *    tokens authorizing a GET of ONE document's preview for 5 minutes. They
 *    mirror the keyring-HMAC design of `signFsUploadToken`
 *    (`packages/core/src/storage-fs.ts`) and REUSE the same `UPLOAD_SIGNING_SECRET`
 *    keyring — no new boot secret. (Trade-off: a dedicated secret would let the
 *    preview capability rotate independently of upload URLs; reusing the upload
 *    secret keeps the OSS boot surface smaller. The static HMAC domain separator
 *    below means the two token types can never be substituted for each other
 *    even though they share the key.)
 *  - {@link buildPreviewCsp} — the strict CSP string, reused verbatim for both
 *    the response header and the injected `<meta>` tag.
 *  - {@link injectMetaCsp} — parse-time injection of a duplicate CSP as the first
 *    child of `<head>`, so the policy binds even on the `srcdoc`/relative-URL
 *    paths a header alone can miss.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Preview capability lifetime — deliberately short (a render link, not a session). */
export const PREVIEW_TOKEN_TTL_SECONDS = 300;

/**
 * Buffer cap for the meta-CSP injection transform. Previews are single-file
 * HTML (OpenAI caps HTML files at 16 MiB); 10 MiB is a generous ceiling that
 * still fits comfortably in memory for the buffer-and-transform injection.
 * A larger document is rejected with 413 rather than streamed unmodified.
 */
export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Static HMAC domain separator. Prepended to the signed body so a valid upload
 * token (which shares the `UPLOAD_SIGNING_SECRET` keyring) can never be replayed
 * as a preview token, and vice-versa — even though the payload shapes and field
 * checks already differ, binding the signature to a purpose is defense in depth.
 */
const PREVIEW_TOKEN_DOMAIN = "doc-preview.v1.";

/** Payload encoded inside a preview token. */
export interface PreviewTokenPayload {
  /** Document id the token authorizes a preview of. */
  d: string;
  /** Org the document belongs to (binds the token to a tenant). */
  o: string;
  /** Expiration unix timestamp (seconds). */
  e: number;
  /**
   * Minting actor's dashboard-user id (null for an end-user actor). Bound so
   * the route can re-check a `user_upload` preview against the document's
   * creator — a foreign upload's hand-crafted token is refused (S1).
   */
  u?: string | null;
  /** Minting actor's end-user id (null for a dashboard-user actor). */
  eu?: string | null;
}

/** Split a comma-separated secret into a keyring; drop empties. Mirrors storage-fs. */
function toKeyring(secret: string | readonly string[]): string[] {
  const keys = typeof secret === "string" ? secret.split(",") : [...secret];
  return keys.filter((k) => k.length > 0);
}

/**
 * Encode + HMAC-sign a preview token with the FIRST key of the keyring.
 * Format: base64url(JSON).base64url(HMAC-SHA256), signed over the
 * domain-separated body. Mirrors `signFsUploadToken`.
 */
export function signPreviewToken(
  payload: PreviewTokenPayload,
  secret: string | readonly string[],
): string {
  const [activeKey] = toKeyring(secret);
  if (!activeKey) throw new Error("signPreviewToken requires at least one signing key");
  const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const sig = createHmac("sha256", activeKey)
    .update(PREVIEW_TOKEN_DOMAIN + body)
    .digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verify + decode a preview token. Returns the payload on success, null on any
 * failure. Verifies against EVERY key of the keyring (constant-time per key) so
 * tokens signed before a rotation stay valid; rejects expired tokens and
 * payloads missing the required fields. Mirrors `verifyFsUploadToken`.
 */
export function verifyPreviewToken(
  token: string,
  secret: string | readonly string[],
): PreviewTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  let valid = false;
  for (const key of toKeyring(secret)) {
    const b = Buffer.from(
      createHmac("sha256", key)
        .update(PREVIEW_TOKEN_DOMAIN + body)
        .digest("base64url"),
    );
    if (a.length === b.length && timingSafeEqual(a, b)) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;
  let payload: PreviewTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as PreviewTokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.e !== "number" || payload.e < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.d !== "string" || !payload.d) return null;
  if (typeof payload.o !== "string" || !payload.o) return null;
  return payload;
}

/**
 * Is `mime` an HTML document? Tolerates a parameterized value
 * (`text/html; charset=utf-8`) — only the type/subtype matters for the preview
 * gate. Retained as a focused, tested utility; the DTO and route classify via
 * {@link previewKind} (of which HTML is one kind).
 */
export function isHtmlMime(mime: string): boolean {
  return mime.split(";", 1)[0]!.trim().toLowerCase() === "text/html";
}

/**
 * The four ways a document can be previewed in-browser (or null for "not
 * previewable"). Drives BOTH the DTO's `preview_kind`/`previewable` derivation
 * AND the preview route's serving branch — a single source of truth, so the set
 * of previewable types can never drift between "advertised as previewable" and
 * "actually served".
 */
export type PreviewKind = "html" | "image" | "pdf" | "text";

/**
 * Image mimes served inline, byte-for-byte. Deliberately EXCLUDES
 * `image/svg+xml`: an SVG is ACTIVE content (it can embed `<script>` and event
 * handlers and runs in the embedding context), so it is not inert like a raster
 * image. Routing it safely would mean serving it through the full HTML-style
 * CSP + `sandbox="allow-scripts"` hardening — extra machinery for a rare case —
 * so instead SVG is simply not previewable (still downloadable). See
 * docs/architecture/DOCUMENTS.md → "Preview kinds".
 */
const PREVIEW_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Text-family mimes previewed as PLAINTEXT. A conservative allowlist, NOT a
 * blanket `text/*`: every entry is inert once the route relabels it
 * `text/plain` (killing any markdown→HTML sniff surface). `application/json` is
 * the common structured-text case; `application/xml` / SVG are excluded (XML can
 * host active content).
 */
const PREVIEW_TEXT_MIMES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/**
 * Classify a document's mime into its {@link PreviewKind}, or null when it is
 * not previewable. Tolerates a parameterized mime (`text/plain; charset=…`) —
 * only the type/subtype is matched.
 */
export function previewKind(mime: string): PreviewKind | null {
  const base = mime.split(";", 1)[0]!.trim().toLowerCase();
  if (base === "text/html") return "html";
  if (base === "application/pdf") return "pdf";
  if (PREVIEW_IMAGE_MIMES.has(base)) return "image";
  if (PREVIEW_TEXT_MIMES.has(base)) return "text";
  return null;
}

/**
 * The CSP for an INERT preview kind (image / pdf / text). These bytes cannot
 * execute in the embedding origin (native raster/PDF viewer, or relabelled
 * plaintext), so the policy is pure belt-and-braces: `default-src 'none'` grants
 * nothing, and `frame-ancestors` pins who may frame the response to the app
 * origin (the PDF path is embedded in an iframe). Distinct from
 * {@link buildPreviewCsp}, which must re-grant inline script/style for the
 * active HTML path.
 */
export function buildInertPreviewCsp(appOrigin: string): string {
  return ["default-src 'none'", `frame-ancestors ${appOrigin}`].join("; ");
}

/**
 * The strict Content-Security-Policy for the preview response — isolation over
 * sanitization. `default-src 'none'` denies everything, then only the minimum is
 * re-granted: inline scripts/styles (so the agent's page renders), data:/blob:
 * images and media, data: fonts. `connect-src 'none'` kills fetch/XHR/WebSocket/
 * EventSource exfil; `form-action 'none'` kills form-post exfil; `base-uri 'none'`
 * blocks `<base>` hijacking. `frame-ancestors` is pinned to the app origin so
 * only the platform UI may frame the preview (clickjacking / re-embed defense).
 */
export function buildPreviewCsp(appOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${appOrigin}`,
    "base-uri 'none'",
  ].join("; ");
}

/**
 * Inject a `<meta http-equiv="Content-Security-Policy">` duplicating the CSP as
 * the FIRST child of `<head>`. A header alone can be bypassed on some
 * relative-URL / `srcdoc` paths; a parse-time meta CSP binds the policy to the
 * document itself, immovable by script. `frame-ancestors` is silently ignored in
 * a meta context (per spec) — harmless, and the response header still enforces
 * it. Creates a `<head>` (or the whole element) when the document lacks one.
 *
 * Buffer-and-transform (the caller reads the whole body first, bounded by
 * {@link PREVIEW_MAX_BYTES}) — correct and simple, versus fragile regex
 * streaming across chunk boundaries.
 */
export function injectMetaCsp(html: string, csp: string): string {
  // The CSP contains only single quotes, never double — but defend the
  // double-quoted attribute against any exotic origin all the same.
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "%22")}">`;

  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const idx = headOpen.index + headOpen[0].length;
    return html.slice(0, idx) + meta + html.slice(idx);
  }

  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const idx = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, idx) + `<head>${meta}</head>` + html.slice(idx);
  }

  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const idx = doctype.index + doctype[0].length;
    return html.slice(0, idx) + `<head>${meta}</head>` + html.slice(idx);
  }

  return `<head>${meta}</head>` + html;
}
