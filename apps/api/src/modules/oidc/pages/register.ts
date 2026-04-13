// SPDX-License-Identifier: Apache-2.0

/**
 * Server-rendered registration page for the OIDC authorize flow.
 *
 * Served at GET /api/oauth/register. After successful sign-up the user
 * has a Better Auth session and is redirected to the authorize endpoint
 * to continue the OAuth flow.
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import { renderSocialButtons, renderSocialSignInScript } from "./social-sign-in-script.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface RegisterPageProps {
  queryString: string;
  error?: string;
  email?: string;
  name?: string;
  csrfToken: string;
  branding: ResolvedAppBranding;
  socialProviders?: { google?: boolean; github?: boolean };
  /**
   * Kept for type-parity with `LoginPageProps.allowSignup` so route
   * handlers can pass a single `allowSignupForClient(...)` result to every
   * page renderer. In practice this component is never rendered with
   * `allowSignup=false` — the register GET handler returns an error page
   * in that case instead of calling this function.
   */
  allowSignup?: boolean;
}

export function renderRegisterPage(props: RegisterPageProps): RawHtml {
  const action = `/api/oauth/register${props.queryString}`;
  const title = `Créer un compte — ${props.branding.name}`;

  // Social sign-in is wired client-side via `renderSocialSignInScript()`
  // — see login.ts for the full rationale (BA's native endpoint is
  // POST-only, so we match the `authClient.signIn.social()` SDK pattern).
  const google = props.socialProviders?.google ?? false;
  const github = props.socialProviders?.github ?? false;
  const hasSocial = google || github;

  const loginUrl = `/api/oauth/login${props.queryString}`;

  const bodyHtml = html`
    <h1>Créer un compte</h1>
    <p>Inscrivez-vous pour continuer.</p>
    ${props.error ? html`<div class="error">${props.error}</div>` : null}
    <form method="POST" action="${action}" autocomplete="on">
      <input type="hidden" name="_csrf" value="${props.csrfToken}" />
      <input
        type="text"
        name="name"
        placeholder="Nom"
        required
        autofocus
        value="${props.name ?? ""}"
      />
      <input type="email" name="email" placeholder="Email" required value="${props.email ?? ""}" />
      <input
        type="password"
        name="password"
        placeholder="Mot de passe (8 caractères min.)"
        required
        minlength="8"
      />
      <button type="submit">Créer mon compte</button>
    </form>
    ${renderSocialButtons({ google, github })}
    <div class="footer-links">
      <a href="${loginUrl}">Déjà un compte ? Se connecter</a>
    </div>
    ${hasSocial ? renderSocialSignInScript() : null}
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
}
