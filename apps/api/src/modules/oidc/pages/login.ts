// SPDX-License-Identifier: Apache-2.0

/**
 * End-user login page.
 *
 * Served at GET /api/oauth/enduser/login as an anonymous public page. The
 * Better Auth oauth-provider plugin redirects unauthenticated users here
 * during the OAuth authorize flow, passing through query parameters
 * (client_id, redirect_uri, state, code_challenge, code_challenge_method,
 * scope). The form POSTs back to the same path with email/password + a
 * CSRF token — the POST handler completes sign-in against Better Auth,
 * then redirects to /api/oauth/enduser/consent with the same query string.
 */

import { html, type RawHtml } from "./html.ts";
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
  // queryString is interpolated through the `html` tag below and auto-escaped.
  const action = `/api/oauth/enduser/login${props.queryString}`;
  const { name: brandName, logoUrl, primaryColor: primary, accentColor: accent } = props.branding;
  const title = `Connexion à ${brandName}`;
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          body {
            font-family: system-ui, sans-serif;
            max-width: 400px;
            margin: 80px auto;
            padding: 0 20px;
            color: #111;
          }
          header.brand {
            text-align: center;
            margin-bottom: 24px;
          }
          header.brand img {
            max-height: 48px;
            max-width: 200px;
            display: block;
            margin: 0 auto 12px;
          }
          header.brand .name {
            font-size: 14px;
            font-weight: 600;
            color: #111;
            letter-spacing: 0.02em;
          }
          h1 {
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
          }
          p {
            color: #555;
          }
          form {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-top: 24px;
          }
          input {
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 6px;
            font-size: 16px;
          }
          button {
            padding: 12px;
            background: ${primary};
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            cursor: pointer;
          }
          button:hover {
            background: ${accent};
          }
          .error {
            color: #dc2626;
            font-size: 14px;
            padding: 8px 12px;
            background: #fef2f2;
            border-radius: 6px;
          }
        </style>
      </head>
      <body>
        <header class="brand">
          ${logoUrl ? html`<img src="${logoUrl}" alt="${brandName}" />` : null}
          <div class="name">${brandName}</div>
        </header>
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
      </body>
    </html> `;
}
