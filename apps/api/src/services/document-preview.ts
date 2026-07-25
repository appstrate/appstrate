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
 *    tokens authorizing a GET of ONE document's preview for 5 minutes. They are
 *    the shared keyring-HMAC codec (`@appstrate/afps-shared/signed-token`, the
 *    same one behind upload tokens) under the preview domain, and REUSE the
 *    `UPLOAD_SIGNING_SECRET` keyring — no new boot secret. (Trade-off: a
 *    dedicated secret would let the preview capability rotate independently of
 *    upload URLs; reusing the upload secret keeps the OSS boot surface smaller.
 *    The mandatory HMAC domain separator means the two token types can never be
 *    substituted for each other even though they share the key.)
 *  - {@link buildPreviewCsp} — the strict CSP string, reused verbatim for both
 *    the response header and the injected `<meta>` tag.
 *  - {@link injectMetaCsp} — parse-time injection of a duplicate CSP as the first
 *    child of `<head>`, so the policy binds even on the `srcdoc`/relative-URL
 *    paths a header alone can miss.
 */

import { signKeyringToken, verifyKeyringToken } from "@appstrate/afps-shared/signed-token";
import { normalizeMime } from "./mime-policy.ts";

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
 * Static HMAC domain separator. Mixed into the signed content so a valid upload
 * token (which shares the `UPLOAD_SIGNING_SECRET` keyring) can never be replayed
 * as a preview token — and, since upload tokens carry their own domain, not the
 * other way round either. The separation is symmetric because the shared codec
 * takes the domain as a required argument, not an optional one.
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

/**
 * Encode + HMAC-sign a preview token with the FIRST key of the keyring, bound
 * to {@link PREVIEW_TOKEN_DOMAIN}.
 */
export function signPreviewToken(
  payload: PreviewTokenPayload,
  secret: string | readonly string[],
): string {
  return signKeyringToken(PREVIEW_TOKEN_DOMAIN, payload, secret);
}

/**
 * Verify + decode a preview token. Returns the payload on success, null on any
 * failure. Verifies against EVERY key of the keyring (constant-time per key) so
 * tokens signed before a rotation stay valid; rejects expired tokens and
 * payloads missing the required fields.
 */
export function verifyPreviewToken(
  token: string,
  secret: string | readonly string[],
): PreviewTokenPayload | null {
  const payload = verifyKeyringToken<PreviewTokenPayload>(PREVIEW_TOKEN_DOMAIN, token, secret);
  if (!payload) return null;
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
  return normalizeMime(mime) === "text/html";
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
  const base = normalizeMime(mime);
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
 * Decide whether agent HTML may be served as ACTIVE content for this request
 * (`true` = parse and execute as `text/html` under the hardened CSP; `false` =
 * serve the same bytes relabelled `text/plain`, so the browser shows the source
 * instead of running it).
 *
 * The CSP built by {@link buildPreviewCsp} blocks exfiltration (`connect-src`,
 * `form-action`, `img-src`, `base-uri`) but NOT script execution itself — that
 * is by design, the page has to render. Whether execution is harmless depends
 * entirely on WHICH origin the script ends up running in:
 *
 *  - **Separate `USERCONTENT_URL` origin** — safe. The script runs on a
 *    throwaway domain with its own cookie jar and storage partition; it cannot
 *    reach the app's session no matter how the response is loaded. `active`
 *    unconditionally. This branch trusts that the configured origin really is
 *    separate, which is why the env schema (`@appstrate/env`) refuses to boot
 *    when `USERCONTENT_URL` shares `APP_URL`'s host — presence must never be
 *    taken as proof of separation on its own.
 *  - **Same-origin mode (`USERCONTENT_URL` unset — the OSS default)** — safe
 *    ONLY inside the SPA's `sandbox="allow-scripts"` iframe, which gives the
 *    document an opaque origin. `preview_url` is an absolute URL with a 300 s
 *    token, so it can also be opened TOP-LEVEL (new tab, shared link). There
 *    the sandbox attribute does not exist: the script runs on `APP_URL` with
 *    full access to the SPA's `localStorage`/`sessionStorage`, non-HttpOnly
 *    cookies, and same-origin navigation. That is the hole this closes.
 *
 * `Sec-Fetch-Dest` is a browser-set, script-unforgeable header, so it is the
 * authoritative statement of the loading context. In same-origin mode the
 * decision is fail-CLOSED: active HTML requires a proven nested-document load
 * (`iframe`); a top-level navigation (`document`), a bare `fetch` (`empty`),
 * an `object`/`embed` load, and a MISSING header (non-browser client, or a
 * browser too old to send it — Safari < 16.4) all degrade to inert source.
 * Degrading rather than erroring keeps the link useful: the holder of a valid
 * token may read the source, which it could download anyway — it just cannot
 * make it execute in the app origin.
 */
export function mayServeActiveHtml(input: {
  /** True when the preview is served from a dedicated `USERCONTENT_URL` origin. */
  separateOrigin: boolean;
  /** Raw `Sec-Fetch-Dest` request header, or null when absent. */
  secFetchDest: string | null;
}): boolean {
  if (input.separateOrigin) return true;
  return input.secFetchDest === "iframe";
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
