// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side expiry detection for the OIDC login page.
 *
 * ROLE: UX polish only. Better Auth signs each login link with an `exp`
 * (Unix seconds); when it lapses the SERVER already restarts the flow in
 * place (`isLoginLinkExpired` → 302 through `/api/auth/oauth2/authorize` →
 * fresh signed link + banner). This script detects the *approaching* `exp`
 * BEFORE the user submits, so a link that went stale while the tab sat in
 * the background is refreshed (or flagged) without a failed round-trip.
 *
 * ZERO SECURITY VALUE: the server expiry check stays authoritative. This
 * script never gates anything — it only refreshes early or shows a hint.
 * Client clock skew is safe both ways: a skewed-slow clock lets a stale link
 * through to the server, which catches it and restarts; a skewed-fast clock
 * refreshes a still-valid link, which is harmless once — but a clock fast by
 * more than the link TTL would see EVERY fresh link as already past deadline
 * and silently refresh in a tight loop the server cannot detect (each bounce
 * mints a genuinely fresh link, so the server-side loop guard never engages).
 * A per-tab `sessionStorage` counter therefore caps consecutive silent
 * refreshes; past the cap the script degrades to the DIRTY behavior (banner
 * with a manual refresh link). This also stops an abandoned pristine tab
 * from re-refreshing forever every ~TTL.
 *
 * CSP: login/register pages target a strict `script-src 'self'`, so the
 * behavior ships as an EXTERNAL asset (served verbatim by
 * `GET /api/oauth/assets/login-expiry.js`) — never inlined, no nonce.
 * The source is a module-level string constant with zero user-controlled
 * values, matching `social-sign-in-script.ts`.
 *
 * Contract with the page markup (owned by `login.ts`):
 *   - The `<form>` MUST carry `data-login-exp="<unix-seconds>"` and
 *     `data-refresh-url="<authorize-restart-url>"`.
 *   - A hidden warning element (`[data-expiry-warning]` with the `hidden`
 *     attribute) MUST exist for the DIRTY-form path to un-hide.
 */

import { html, raw, type RawHtml } from "./html.ts";

/**
 * Renders the (hidden by default) "this login page is about to expire"
 * banner. Un-hidden by `LOGIN_EXPIRY_SCRIPT` only when the user has already
 * typed into the form at the deadline — otherwise the script silently
 * refreshes instead. Reuses the layout's `.error` look (no dedicated
 * `.warning` class exists and the shared layout has no per-page style slot,
 * so this is the least-invasive fit).
 *
 * Markup is the contract consumed by `LOGIN_EXPIRY_SCRIPT`: the
 * `[data-expiry-warning]` attribute + the `hidden` attribute must match the
 * selector/toggle the script relies on.
 */
export function renderExpiryWarning(refreshUrl: string): RawHtml {
  return html`<div class="error" data-expiry-warning hidden>
    Cette page de connexion va expirer. <a href="${refreshUrl}">Rafraîchir la page</a>
  </div>`;
}

/** Public URL for the externalized expiry-detection script. */
export const LOGIN_EXPIRY_SCRIPT_PATH = "/api/oauth/assets/login-expiry.js";

/**
 * Source of the externalized expiry-detection helper, served verbatim by
 * `GET /api/oauth/assets/login-expiry.js`. Module-level constant (zero build
 * step, long-cacheable — only changes on deploy).
 *
 * Behavior:
 *   - Reads `data-login-exp` (Unix seconds) + `data-refresh-url` off the
 *     `form[data-login-exp]`. Bails silently if absent or non-finite.
 *   - Deadline = `exp - 30s`. A one-time `input` listener marks the form
 *     DIRTY the moment the user types.
 *   - At the deadline: PRISTINE → `location.replace(refreshUrl)` (silent —
 *     no cookie is set so the fresh page shows no banner); DIRTY → un-hide
 *     the warning banner once, never navigate under the user's fingers.
 *   - Triggers: a `setTimeout` (clamped >= 0) AND re-checks wall-clock on
 *     `visibilitychange` (tab becomes visible) + `pageshow` (bfcache
 *     restore). Background-tab timers are throttled by the browser, so the
 *     dominant real case — "user returns to the tab 20 minutes later" — is
 *     caught by the visibility re-check, not the timer.
 *   - A `done` flag disarms every listener/timer after firing either action.
 */
export const LOGIN_EXPIRY_SCRIPT = `(function () {
  var form = document.querySelector("form[data-login-exp]");
  if (!form) return;
  var exp = Number(form.getAttribute("data-login-exp"));
  var refreshUrl = form.getAttribute("data-refresh-url");
  if (!isFinite(exp) || !refreshUrl) return;

  // Per-tab cap on consecutive silent refreshes (see file header). Wrapped in
  // try/catch: sessionStorage can throw in some privacy modes, in which case
  // the guard degrades to "always at cap" via null (banner instead of loop).
  var REFRESH_CAP = 3;
  var REFRESH_KEY = "oidcLoginExpiryRefreshes";
  function readRefreshCount() {
    try {
      var n = Number(sessionStorage.getItem(REFRESH_KEY));
      return isFinite(n) && n >= 0 ? n : 0;
    } catch (_e) {
      return null;
    }
  }
  function bumpRefreshCount(n) {
    try {
      sessionStorage.setItem(REFRESH_KEY, String(n + 1));
      return true;
    } catch (_e) {
      return false;
    }
  }

  // Refresh 30s before the server-side exp so the fresh link is ready
  // before the old one is actually rejected. Client clock skew is safe both
  // ways: early refresh of a valid link is harmless (a new link is minted),
  // late is caught by the authoritative server check.
  var deadlineMs = (exp - 30) * 1000;
  var dirty = false;
  var done = false;
  var timer = null;

  function disarm() {
    done = true;
    if (timer !== null) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", check);
    form.removeEventListener("input", onInput);
  }

  function showBanner() {
    var banner = document.querySelector("[data-expiry-warning]");
    if (banner) banner.removeAttribute("hidden");
    disarm();
  }

  function fire() {
    if (done) return;
    if (dirty) {
      // Never yank the page from under a user who is mid-typing — surface a
      // non-blocking banner with a manual refresh link instead.
      showBanner();
      return;
    }
    // Pristine form: silently swap to a fresh link. No notice cookie is set
    // on this path, so the fresh page renders with no banner — the user
    // never notices. Bounded by the per-tab refresh cap; at (or without a
    // readable) counter, fall back to the banner.
    var count = readRefreshCount();
    if (count === null || count >= REFRESH_CAP || !bumpRefreshCount(count)) {
      showBanner();
      return;
    }
    disarm();
    location.replace(refreshUrl);
  }

  function check() {
    if (done) return;
    if (Date.now() >= deadlineMs) fire();
  }

  function onVisible() {
    // Background-tab setTimeout is throttled, so re-check wall-clock against
    // the deadline whenever the tab becomes visible again.
    if (document.visibilityState === "visible") check();
  }

  function onInput() {
    dirty = true;
    form.removeEventListener("input", onInput);
  }

  form.addEventListener("input", onInput);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", check);
  timer = setTimeout(fire, Math.max(0, deadlineMs - Date.now()));
})();
`;

/**
 * `<script>` tag referencing the externalized helper. CSP-safe: loaded from
 * the same origin, no inline code.
 */
export function renderLoginExpiryScript(): RawHtml {
  return raw(`<script src="${LOGIN_EXPIRY_SCRIPT_PATH}" defer></script>`);
}
