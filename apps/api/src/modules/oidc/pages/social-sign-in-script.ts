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

import { html, raw, type RawHtml } from "./html.ts";

export interface SocialButtonsOptions {
  google?: boolean;
  github?: boolean;
  /** When set, renders a "magic link" link next to the social buttons. */
  magicLinkUrl?: string | null;
}

const GOOGLE_ICON = raw(`<svg viewBox="0 0 24 24" width="18" height="18">
  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
</svg>`);

const GITHUB_ICON = raw(`<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
</svg>`);

const MAGIC_LINK_ICON = raw(`<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
</svg>`);

/**
 * Renders the "or / [Google] [GitHub] [Magic link]" block shared by the
 * login and register pages. Returns `null` when no alternative method is
 * enabled so callers can conditionally render without wrapping.
 *
 * Button markup is the contract consumed by `SOCIAL_SIGN_IN_SCRIPT` —
 * `<button data-social-provider="...">` must match the selector the
 * script listens on.
 */
export function renderSocialButtons(opts: SocialButtonsOptions): RawHtml | null {
  const google = opts.google ?? false;
  const github = opts.github ?? false;
  const magicLinkUrl = opts.magicLinkUrl ?? null;
  if (!google && !github && !magicLinkUrl) return null;
  return html`
    <div class="divider"><span>ou</span></div>
    <div class="social-buttons">
      ${google
        ? html`<button type="button" data-social-provider="google" class="social-btn google">
            ${GOOGLE_ICON} Continuer avec Google
          </button>`
        : null}
      ${github
        ? html`<button type="button" data-social-provider="github" class="social-btn github">
            ${GITHUB_ICON} Continuer avec GitHub
          </button>`
        : null}
      ${magicLinkUrl
        ? html`<a href="${magicLinkUrl}" class="social-btn magic-link">
            ${MAGIC_LINK_ICON} Recevoir un lien de connexion
          </a>`
        : null}
    </div>
  `;
}

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
    } catch (_err) {
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
