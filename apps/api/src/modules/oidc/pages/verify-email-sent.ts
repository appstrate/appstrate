// SPDX-License-Identifier: Apache-2.0

/**
 * Server-rendered "check your email" interstitial for the OIDC authorize
 * flow. Shown after:
 *   - POST /api/oauth/register with SMTP enabled (BA skips session creation
 *     because `requireEmailVerification: true`)
 *   - POST /api/oauth/login for an unverified account (BA re-sends the
 *     verification email via `sendOnSignIn` and throws EMAIL_NOT_VERIFIED)
 *
 * The verification email embeds a `callbackURL` pointing back at
 * `/api/auth/oauth2/authorize${queryString}` — once the user clicks the
 * link, BA sets the session cookie (via `autoSignInAfterVerification`) and
 * 302s to that callback, resuming the OAuth flow exactly where it paused.
 * The third-party client never sees the intermediate state.
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface VerifyEmailSentPageProps {
  queryString: string;
  branding: ResolvedAppBranding;
  /** Email address the verification link was sent to (pre-filled for display). */
  email: string;
}

export function renderVerifyEmailSentPage(props: VerifyEmailSentPageProps): RawHtml {
  const loginUrl = `/api/oauth/login${props.queryString}`;
  const title = `Vérifiez votre email — ${props.branding.name}`;

  const bodyHtml = html`
    <h1>Vérifiez votre email</h1>
    <p>
      Un lien de vérification vient d'être envoyé à <strong>${props.email}</strong>. Cliquez sur le
      lien dans l'email pour activer votre compte et continuer la connexion à
      ${props.branding.name}.
    </p>
    <p class="muted">
      Vous ne recevez rien ? Vérifiez votre dossier spam ou réessayez de vous connecter depuis la
      page de connexion pour recevoir un nouveau lien.
    </p>
    <div class="footer-links">
      <a href="${loginUrl}">Retour à la connexion</a>
    </div>
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 440, bodyHtml });
}
