// SPDX-License-Identifier: Apache-2.0

/**
 * Server-rendered login page for the OIDC authorize flow.
 *
 * Served at GET /api/oauth/login. Supports:
 *   - Email/password authentication
 *   - Social login (Google, GitHub) — redirects through Better Auth's
 *     social sign-in then back to the authorize endpoint
 *   - Registration link → /api/oauth/register with same OAuth params
 *   - Forgot password link (when SMTP is enabled)
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import { renderSocialButtons, renderSocialSignInScript } from "./social-sign-in-script.ts";
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
  /** Available social auth providers. */
  socialProviders?: { google?: boolean; github?: boolean };
  /** Whether SMTP is configured (enables forgot password + magic link). */
  smtpEnabled?: boolean;
  /**
   * Whether signup is open for this client's underlying org. When `false`
   * (org-level client with `allow_signup=false`), only the "Créer un
   * compte" CTA is hidden. Social sign-in and magic-link stay visible so
   * existing members who linked a Google/GitHub account (or never set a
   * password) can still sign in. Orphan user creation is prevented at the
   * BA `beforeSignup` hook layer (`oidcBeforeSignupGuard`), so showing
   * these buttons is safe. Defaults to `true` (backward compatible for
   * app/instance clients and pre-feature callers).
   */
  allowSignup?: boolean;
}

export function renderLoginPage(props: LoginPageProps): RawHtml {
  const action = `/api/oauth/login${props.queryString}`;
  const title = `Connexion à ${props.branding.name}`;

  // Social sign-in is wired client-side via `renderSocialSignInScript()`
  // — it POSTs to Better Auth's native `/api/auth/sign-in/social` the way
  // the official `authClient.signIn.social()` SDK does, so BA's signed
  // `better-auth.state` cookie flows natively without any server bridge.
  //
  // Social + magic-link stay visible regardless of `allowSignup` — an
  // existing member may have linked a Google/GitHub account or rely on
  // magic-link to sign in without a password. Orphan creation on closed
  // clients is blocked by the `beforeSignup` BA hook
  // (`oidcBeforeSignupGuard`).
  const allowSignup = props.allowSignup ?? true;
  const google = props.socialProviders?.google ?? false;
  const github = props.socialProviders?.github ?? false;
  const magicLink = props.smtpEnabled ?? false;

  const registerUrl = `/api/oauth/register${props.queryString}`;
  const magicLinkUrl = `/api/oauth/magic-link${props.queryString}`;
  const forgotPasswordUrl = `/api/oauth/forgot-password${props.queryString}`;

  const bodyHtml = html`
    <h1>Connexion</h1>
    <p>Connectez-vous pour continuer.</p>
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
    ${renderSocialButtons({
      google,
      github,
      magicLinkUrl: magicLink ? magicLinkUrl : null,
    })}
    <div class="footer-links">
      ${allowSignup ? html`<a href="${registerUrl}">Créer un compte</a>` : null}
      ${allowSignup && props.smtpEnabled
        ? html`<span class="sep">·</span><a href="${forgotPasswordUrl}">Mot de passe oublié ?</a>`
        : props.smtpEnabled
          ? html`<a href="${forgotPasswordUrl}">Mot de passe oublié ?</a>`
          : null}
    </div>
    ${google || github ? renderSocialSignInScript() : null}
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
}
