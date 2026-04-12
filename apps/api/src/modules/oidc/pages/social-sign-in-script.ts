// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side bootstrap for the social sign-in buttons on the login and
 * register pages. Uses Better Auth's native POST endpoint the way the
 * official `authClient.signIn.social()` SDK does — the browser submits
 * the POST with credentials, BA writes its signed `better-auth.state`
 * cookie natively, and we follow the `url` returned in the JSON body.
 *
 * Serving social through a small client-side fetch (instead of a
 * server-side bridge route) means:
 *   - BA's cookie plumbing runs unchanged — no in-process dispatch quirks
 *   - `callbackURL` is built from `window.location` so it stays absolute
 *     without any server-side URL reconstruction
 *   - No custom route, no `publicPaths` entry, no CSRF cookie churn
 *
 * The script is a static string (no user-controlled values) and served
 * as an external asset — NOT inlined — so pages that adopt a strict CSP
 * (`script-src 'self'`) remain compatible without needing `unsafe-inline`
 * or per-request nonces.
 */

import { raw, type RawHtml } from "./html.ts";

/** Public URL for the externalized sign-in helper script. */
export const SOCIAL_SIGN_IN_SCRIPT_PATH = "/api/oauth/assets/social-sign-in.js";

/**
 * Source of the externalized social sign-in helper, served verbatim by
 * `GET /api/oauth/assets/social-sign-in.js`. Kept as a module-level
 * constant so it ships with zero build step and the route handler can
 * slap a long-lived `Cache-Control` header on it.
 *
 * Contract with the page markup:
 *   - Each social button MUST be `<button type="button"
 *     data-social-provider="google|github">`
 *   - The button's enclosing page MUST carry the OAuth query string in
 *     `window.location.search` so `callbackURL` points at the authorize
 *     endpoint for the same client.
 */
export const SOCIAL_SIGN_IN_SCRIPT = `(function () {
  function buildURLs() {
    var origin = window.location.origin;
    var search = window.location.search;
    return {
      callbackURL: origin + "/api/auth/oauth2/authorize" + search,
      errorCallbackURL: origin + "/api/oauth/login" + search,
    };
  }
  async function signInSocial(button, provider) {
    var original = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = "Redirection\\u2026";
    var urls = buildURLs();
    try {
      var res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          provider: provider,
          callbackURL: urls.callbackURL,
          errorCallbackURL: urls.errorCallbackURL,
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      if (!data || !data.url) throw new Error("missing url");
      window.location.href = data.url;
    } catch (err) {
      console.error("social sign-in failed", err);
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.innerHTML = original;
      window.alert("Erreur de connexion. Veuillez r\\u00e9essayer.");
    }
  }
  document.addEventListener("click", function (e) {
    var target = e.target;
    var button = target && target.closest ? target.closest("[data-social-provider]") : null;
    if (!button || button.disabled) return;
    var provider = button.dataset && button.dataset.socialProvider;
    if (!provider) return;
    e.preventDefault();
    signInSocial(button, provider);
  });
})();
`;

/**
 * `<script>` tag referencing the externalized helper. CSP-safe: the
 * browser loads it from the same origin as the page, no inline code.
 */
export function renderSocialSignInScript(): RawHtml {
  return raw(`<script src="${SOCIAL_SIGN_IN_SCRIPT_PATH}" defer></script>`);
}
