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
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface RegisterPageProps {
  queryString: string;
  error?: string;
  email?: string;
  name?: string;
  csrfToken: string;
  branding: ResolvedAppBranding;
  socialProviders?: { google?: boolean; github?: boolean };
}

export function renderRegisterPage(props: RegisterPageProps): RawHtml {
  const action = `/api/oauth/register${props.queryString}`;
  const title = `Créer un compte — ${props.branding.name}`;

  const authorizeUrl = `/api/auth/oauth2/authorize${props.queryString}`;
  const encodedCallback = encodeURIComponent(authorizeUrl);

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
    ${hasSocial
      ? html`
          <div class="divider"><span>ou</span></div>
          <div class="social-buttons">
            ${google
              ? html`<a
                  href="/api/auth/sign-in/social?provider=google&callbackURL=${encodedCallback}"
                  class="social-btn google"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18">
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                  Continuer avec Google
                </a>`
              : null}
            ${github
              ? html`<a
                  href="/api/auth/sign-in/social?provider=github&callbackURL=${encodedCallback}"
                  class="social-btn github"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path
                      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                    />
                  </svg>
                  Continuer avec GitHub
                </a>`
              : null}
          </div>
        `
      : null}
    <div class="footer-links">
      <a href="${loginUrl}">Déjà un compte ? Se connecter</a>
    </div>
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 400, bodyHtml });
}
