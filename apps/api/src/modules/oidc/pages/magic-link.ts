// SPDX-License-Identifier: Apache-2.0

/**
 * Server-rendered magic-link sign-in page for the OIDC authorize flow.
 *
 * Served at GET/POST /api/oauth/magic-link. After submitting an email, the
 * user receives a Better Auth magic link pointing back at
 * /api/auth/oauth2/authorize${queryString} — clicking it creates a
 * session and resumes the OAuth flow exactly where login would.
 *
 * The page is uniformly in the "sent" state after a successful POST, even
 * if the email doesn't exist (anti-enumeration — matches Better Auth's
 * behavior for requestPasswordReset).
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface MagicLinkPageProps {
  queryString: string;
  error?: string;
  email?: string;
  csrfToken: string;
  branding: ResolvedAppBranding;
  /** True after a successful POST — renders a "check your email" confirmation. */
  sent?: boolean;
}

export function renderMagicLinkPage(props: MagicLinkPageProps): RawHtml {
  const action = `/api/oauth/magic-link${props.queryString}`;
  const loginUrl = `/api/oauth/login${props.queryString}`;
  const title = `Connexion par lien magique — ${props.branding.name}`;

  if (props.sent) {
    const bodyHtml = html`
      <h1>Vérifiez votre email</h1>
      <p>
        Si un compte est associé à <strong>${props.email ?? ""}</strong>, vous recevrez un email
        contenant un lien de connexion. Cliquez sur le lien pour vous connecter.
      </p>
      <p class="muted">Le lien expire dans 7 jours.</p>
      <div class="footer-links">
        <a href="${loginUrl}">Retour à la connexion</a>
      </div>
    `;
    return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
  }

  const bodyHtml = html`
    <h1>Connexion par lien magique</h1>
    <p>Entrez votre email pour recevoir un lien de connexion.</p>
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
      <a href="${loginUrl}">Retour à la connexion par mot de passe</a>
    </div>
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
}
