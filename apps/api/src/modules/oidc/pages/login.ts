// SPDX-License-Identifier: Apache-2.0

/**
 * End-user login page.
 *
 * Served at GET /api/oauth/login as an anonymous public page. The
 * Better Auth oauth-provider plugin redirects unauthenticated users here
 * during the OAuth authorize flow, passing through query parameters
 * (client_id, redirect_uri, state, code_challenge, code_challenge_method,
 * scope). The form POSTs back to the same path with email/password + a
 * CSRF token — the POST handler completes sign-in against Better Auth,
 * then redirects to /api/oauth/consent with the same query string.
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface LoginPageProps {
  /** Raw query string from the authorize redirect — forwarded to the form action. */
  queryString: string;
  /** Optional error message to display above the form. */
  error?: string;
  /** Optional pre-filled email (e.g. after a failed submission). */
  email?: string;
  /** CSRF token injected into the form + paired cookie. */
  csrfToken: string;
  /** Resolved branding for the owning application. */
  branding: ResolvedAppBranding;
}

export function renderLoginPage(props: LoginPageProps): RawHtml {
  const action = `/api/oauth/login${props.queryString}`;
  const title = `Connexion à ${props.branding.name}`;
  const bodyHtml = html`
    <h1>Connexion</h1>
    <p>Connectez-vous pour autoriser l'application.</p>
    ${props.error ? html`<div class="error">${props.error}</div>` : null}
    <form method="POST" action="${action}" autocomplete="on">
      <input type="hidden" name="_csrf" value="${props.csrfToken}" />
      <input
        type="email"
        name="email"
        placeholder="Email"
        required
        autofocus
        value="${props.email ?? ""}"
      />
      <input type="password" name="password" placeholder="Mot de passe" required />
      <button type="submit">Se connecter</button>
    </form>
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
}
