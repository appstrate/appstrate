// SPDX-License-Identifier: Apache-2.0

/**
 * Server-rendered "forgot password" page for the OIDC authorize flow.
 *
 * Served at GET/POST /api/oauth/forgot-password. After submitting an email,
 * Better Auth sends a reset link that redirects back to
 * /api/oauth/reset-password${queryString}&token=... so the user never
 * leaves the branded IdP flow.
 *
 * The "sent" confirmation is rendered uniformly, whether or not an account
 * exists for the submitted email — matches Better Auth's anti-enumeration
 * behavior in requestPasswordReset.
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface ForgotPasswordPageProps {
  queryString: string;
  error?: string;
  email?: string;
  csrfToken: string;
  branding: ResolvedAppBranding;
  sent?: boolean;
}

export function renderForgotPasswordPage(props: ForgotPasswordPageProps): RawHtml {
  const action = `/api/oauth/forgot-password${props.queryString}`;
  const loginUrl = `/api/oauth/login${props.queryString}`;
  const title = `Mot de passe oublié — ${props.branding.name}`;

  if (props.sent) {
    const bodyHtml = html`
      <h1>Vérifiez votre email</h1>
      <p>
        Si un compte est associé à <strong>${props.email ?? ""}</strong>, vous recevrez un email
        contenant un lien pour réinitialiser votre mot de passe.
      </p>
      <div class="footer-links">
        <a href="${loginUrl}">Retour à la connexion</a>
      </div>
    `;
    return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
  }

  const bodyHtml = html`
    <h1>Mot de passe oublié</h1>
    <p>Entrez votre email pour recevoir un lien de réinitialisation.</p>
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
      <button type="submit">Envoyer le lien</button>
    </form>
    <div class="footer-links">
      <a href="${loginUrl}">Retour à la connexion</a>
    </div>
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
}
