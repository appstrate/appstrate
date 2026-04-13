// SPDX-License-Identifier: Apache-2.0

/**
 * Server-rendered reset-password page for the OIDC authorize flow.
 *
 * Reached from the Better Auth reset email via the verification redirect:
 *   `{baseURL}/api/auth/reset-password/{token}?callbackURL=<encoded /api/oauth/reset-password?queryString>`
 *   → BA validates the token, then 302s to
 *     `/api/oauth/reset-password?{queryString}&token={token}`
 *
 * The token is carried via a hidden form field on POST. Better Auth's
 * `resetPassword` does NOT create a session — on success we render a
 * confirmation screen pointing the user back at the OIDC login page so
 * they can sign in with their new password.
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface ResetPasswordPageProps {
  queryString: string;
  /** Reset token from the email link — embedded as a hidden form field. */
  token: string;
  error?: string;
  csrfToken: string;
  branding: ResolvedAppBranding;
  /** True after a successful POST — renders a "password updated" confirmation. */
  success?: boolean;
}

export interface InvalidTokenPageProps {
  queryString: string;
  branding: ResolvedAppBranding;
}

/** Dedicated screen when the verification link is missing/expired. */
export function renderInvalidTokenPage(props: InvalidTokenPageProps): RawHtml {
  const forgotUrl = `/api/oauth/forgot-password${props.queryString}`;
  const loginUrl = `/api/oauth/login${props.queryString}`;
  const title = `Lien invalide — ${props.branding.name}`;
  const bodyHtml = html`
    <h1>Lien invalide ou expiré</h1>
    <p>Ce lien de réinitialisation n'est plus valide. Demandez-en un nouveau pour continuer.</p>
    <div class="footer-links">
      <a href="${forgotUrl}">Demander un nouveau lien</a>
      <span class="sep">·</span><a href="${loginUrl}">Retour à la connexion</a>
    </div>
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
}

export function renderResetPasswordPage(props: ResetPasswordPageProps): RawHtml {
  const action = `/api/oauth/reset-password${props.queryString}`;
  const loginUrl = `/api/oauth/login${props.queryString}`;
  const title = `Réinitialiser le mot de passe — ${props.branding.name}`;

  if (props.success) {
    const bodyHtml = html`
      <h1>Mot de passe mis à jour</h1>
      <p>Votre mot de passe a été réinitialisé. Vous pouvez maintenant vous connecter.</p>
      <div class="footer-links">
        <a href="${loginUrl}">Se connecter</a>
      </div>
    `;
    return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
  }

  const bodyHtml = html`
    <h1>Nouveau mot de passe</h1>
    <p>Choisissez un nouveau mot de passe pour votre compte.</p>
    ${props.error ? html`<div class="error">${props.error}</div>` : null}
    <form method="POST" action="${action}" autocomplete="off">
      <input type="hidden" name="_csrf" value="${props.csrfToken}" />
      <input type="hidden" name="token" value="${props.token}" />
      <input
        type="password"
        name="password"
        placeholder="Nouveau mot de passe (8 caractères min.)"
        required
        minlength="8"
        autofocus
        autocomplete="new-password"
      />
      <input
        type="password"
        name="password_confirm"
        placeholder="Confirmer le mot de passe"
        required
        minlength="8"
        autocomplete="new-password"
      />
      <button type="submit">Réinitialiser</button>
    </form>
    <div class="footer-links">
      <a href="${loginUrl}">Retour à la connexion</a>
    </div>
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
}
