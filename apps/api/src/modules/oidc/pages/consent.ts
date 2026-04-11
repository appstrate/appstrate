// SPDX-License-Identifier: Apache-2.0

/**
 * End-user consent page.
 *
 * Served at GET /api/oauth/enduser/consent after a successful login. The
 * Better Auth oauth-provider plugin hands the flow off here with a pending
 * authorization-code state; the user sees the client's name + requested
 * scopes and clicks "Autoriser" or "Refuser". The form POST completes the
 * authorization code exchange back inside the plugin.
 *
 * A CSRF token pairs with a signed cookie to prevent cross-site consent
 * forgery — the POST handler rejects any submission where the token body
 * field does not match the cookie.
 */

import { html, type RawHtml } from "./html.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

const SCOPE_DESCRIPTIONS_FR: Record<string, string> = {
  openid: "Votre identité",
  profile: "Votre profil",
  email: "Votre adresse email",
  offline_access: "Rester connecté (jeton de rafraîchissement)",
  "agents:read": "Lister vos agents",
  "agents:run": "Lancer des agents pour vous",
  "runs:read": "Consulter votre historique d'exécutions",
  "runs:cancel": "Annuler vos exécutions en cours",
  "connections:read": "Lister vos connexions",
  "connections:connect": "Ajouter des connexions en votre nom",
  "connections:disconnect": "Retirer vos connexions",
  "skills:read": "Lister les skills disponibles",
  "tools:read": "Lister les tools disponibles",
  "providers:read": "Lister les providers disponibles",
  "models:read": "Lister les modèles LLM disponibles",
};

function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS_FR[scope] ?? scope;
}

export interface ConsentPageProps {
  clientName: string;
  scopes: string[];
  /** Form action — typically `/api/oauth/enduser/consent${queryString}`. */
  action: string;
  /** CSRF token injected into the form + paired cookie. */
  csrfToken: string;
  /** Resolved branding for the owning application. */
  branding: ResolvedAppBranding;
}

export function renderConsentPage(props: ConsentPageProps): RawHtml {
  const scopeItems = props.scopes.map((s) => html`<li>${describeScope(s)}</li>`);
  const { name: brandName, logoUrl, primaryColor: primary, accentColor: accent } = props.branding;
  const title = `Autorisation — ${brandName}`;
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          body {
            font-family: system-ui, sans-serif;
            max-width: 440px;
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
          }
          p {
            color: #555;
          }
          .client {
            font-weight: 600;
            color: #111;
          }
          ul.scopes {
            list-style: none;
            padding: 0;
            margin: 16px 0 24px;
            border-top: 1px solid #eee;
          }
          ul.scopes li {
            padding: 10px 0;
            border-bottom: 1px solid #eee;
          }
          .actions {
            display: flex;
            gap: 12px;
            margin-top: 24px;
          }
          .actions form {
            flex: 1;
            margin: 0;
          }
          button {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            cursor: pointer;
          }
          .allow {
            background: ${primary};
            color: white;
          }
          .allow:hover {
            background: ${accent};
          }
          .deny {
            background: #e5e7eb;
            color: #374151;
          }
          .deny:hover {
            background: #d1d5db;
          }
        </style>
      </head>
      <body>
        <header class="brand">
          ${logoUrl ? html`<img src="${logoUrl}" alt="${brandName}" />` : null}
          <div class="name">${brandName}</div>
        </header>
        <h1>Autorisation</h1>
        <p>
          <span class="client">${props.clientName}</span> souhaite accéder à votre compte
          ${brandName}.
        </p>
        <p>Cette application aura accès à :</p>
        <ul class="scopes">
          ${scopeItems}
        </ul>
        <div class="actions">
          <form method="POST" action="${props.action}">
            <input type="hidden" name="_csrf" value="${props.csrfToken}" />
            <input type="hidden" name="accept" value="false" />
            <button type="submit" class="deny">Refuser</button>
          </form>
          <form method="POST" action="${props.action}">
            <input type="hidden" name="_csrf" value="${props.csrfToken}" />
            <input type="hidden" name="accept" value="true" />
            <button type="submit" class="allow">Autoriser</button>
          </form>
        </div>
      </body>
    </html> `;
}
